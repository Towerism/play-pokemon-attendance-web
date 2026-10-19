import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import type { ActingConnection } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type {
  DateRange,
  StaffAssignResult,
  StaffRoleCode,
  Tournament,
  TournamentDetails,
  TournamentParticipant,
} from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { type SessionsService, createSessionsService } from '../sessions/service';
import type { StaffingError } from '../staffing/errors';
import { type StaffingService, createStaffingService } from '../staffing/service';
import { GROUP, ROLES, playing, staffer, tournament } from '../staffing/test-helpers';
import type { PlaySessionResolver } from './resolve';
import { type SubmissionService, type SubmissionView, createSubmissionService } from './service';
import { HELD_BY_OWNER, OWNER, stubConnections } from '../pokemon/test-helpers';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
const DATE = '2026-10-14' as SessionDate;
const T = 't-1';
const ORGANIZER = '9999991';
const DELAY = 1_000;
const id = (s: string) => s as PlayerId;

/**
 * play-tools' tournament staff as a fake, with the semantics spike S6
 * recorded: one staffer per POST, a player id already listed in any role is
 * refused `cannot_duplicate_participant`, records list players and staff.
 * Hooks run before each call and may throw, or return a result to short-circuit.
 */
class FakeStaffTools {
  tournaments: TournamentDetails[] = [];
  participants = new Map<string, TournamentParticipant[]>();
  gone = new Set<string>();

  listLeagues(): Promise<never> {
    return Promise.reject(new Error('a staff job never lists leagues'));
  }
  /** Every call, in order: `read`, `assign <player> <role>`, `change <record> <role>`, `remove <record>`. */
  calls: string[] = [];
  /** Writes with the fake clock's time when each started. */
  writes: { call: string; at: number }[] = [];
  onRead: ((n: number) => unknown) | undefined;
  onAssign: ((playerId: PlayerId, role: string, n: number) => unknown) | undefined;
  onChange: ((recordId: string, n: number) => unknown) | undefined;
  onRemove: ((recordId: string, n: number) => unknown) | undefined;
  onDetails: (() => unknown) | undefined;
  private reads = 0;
  private serial = 0;

  /** Forgets the calls made while setting a test up (adding an assignment reads the tournament too). */
  resetLog(): void {
    this.calls = [];
    this.writes = [];
    this.reads = 0;
  }

  on(t = T): TournamentParticipant[] {
    return this.participants.get(t) ?? [];
  }

  list(...people: TournamentParticipant[]): void {
    this.participants.set(T, [...this.on(), ...people]);
  }

  listStaffRoles = () => ROLES;

  async listTournaments(range?: DateRange): Promise<Tournament[]> {
    return this.tournaments.filter((t) => !range || (t.startsAt && t.startsAt >= range.from && t.startsAt < range.to));
  }

  async getTournament(tournamentId: string): Promise<TournamentDetails> {
    await this.onDetails?.();
    const t =this.tournaments.find((x) => x.id === tournamentId);
    if (!t || this.gone.has(tournamentId)) throw new PokemonUpstreamError('not_found', `No tournament ${tournamentId}`);
    return t;
  }

  async listTournamentParticipants(tournamentId: string): Promise<TournamentParticipant[]> {
    this.calls.push('read');
    this.reads += 1;
    this.onRead?.(this.reads);
    return [...this.on(tournamentId)];
  }

  async assignStaff(tournamentId: string, a: { playerId: PlayerId; role: StaffRoleCode }): Promise<StaffAssignResult> {
    const call = `assign ${a.playerId} ${a.role}`;
    this.calls.push(call);
    this.writes.push({ call, at: clock.getTime() });
    const injected = this.onAssign?.(a.playerId, a.role, this.writes.length) as StaffAssignResult | undefined;
    if (injected) return injected;
    if (this.on(tournamentId).some((p) => p.playerId === a.playerId)) return { status: 'refused', code: 'cannot_duplicate_participant' };
    const recordId = `staff-${++this.serial}`;
    this.participants.set(tournamentId, [...this.on(tournamentId), staffer(a.playerId, a.role, '', recordId)]);
    return { status: 'assigned', recordId };
  }

  async changeStaffRole(tournamentId: string, recordId: string, role: StaffRoleCode): Promise<'changed' | 'not_found'> {
    const call = `change ${recordId} ${role}`;
    this.calls.push(call);
    this.writes.push({ call, at: clock.getTime() });
    const injected = this.onChange?.(recordId, this.writes.length) as 'changed' | 'not_found' | undefined;
    if (injected) return injected;
    const record = this.on(tournamentId).find((p) => p.recordId === recordId);
    if (!record) return 'not_found';
    this.participants.set(
      tournamentId,
      this.on(tournamentId).map((p) => (p === record ? { ...p, role } : p)),
    );
    return 'changed';
  }

  async unassignStaff(tournamentId: string, recordId: string): Promise<'removed' | 'not_found'> {
    const call = `remove ${recordId}`;
    this.calls.push(call);
    this.writes.push({ call, at: clock.getTime() });
    const injected = this.onRemove?.(recordId, this.writes.length) as 'removed' | 'not_found' | undefined;
    if (injected) return injected;
    const before = this.on(tournamentId);
    this.participants.set(tournamentId, before.filter((p) => p.recordId !== recordId));
    return this.on(tournamentId).length < before.length ? 'removed' : 'not_found';
  }

  recordOf(playerId: string): string {
    return this.on().find((p) => p.playerId === playerId)!.recordId;
  }
}

let database: OpenDatabase;
let roster: RosterService;
let sightings: SightingsService;
let sessions: SessionsService;
let staffing: StaffingService;
let upstream: FakeStaffTools;
/** The league's chosen activity group (ADR-0015 §3), or none. */
let connection: { league: { id: string; name: string; displayId: string | null } | null };
/** The professors connected: Olive organizes the tournament; Ash submits attendance. */
let professors: ActingConnection[];
/** The connection each of the staff job's gateways was built for. */
let jobGateways: (number | null)[];
let clock: Date;
let sleeps: number[];
let onSleep: ((signal: AbortSignal) => Promise<void> | void) | undefined;
let logs: { level: string; message: string; fields: unknown }[];
let service: SubmissionService;

const noResolver: PlaySessionResolver = {
  resolve: () => Promise.reject(new Error('a staff job never resolves play sessions')),
  find: () => Promise.reject(new Error('a staff job never resolves play sessions')),
};
const noAttendance = {
  listAttendance: () => Promise.reject(new Error('a staff job never reads attendance')),
  addAttendanceBulk: () => Promise.reject(new Error('a staff job never adds attendance')),
  removeAttendance: () => Promise.reject(new Error('a staff job never removes attendance')),
};

function build(over: { staffDelayMs?: number } = {}): SubmissionService {
  const record = (level: string) => (message: string, fields?: unknown) => logs.push({ level, message, fields });
  return createSubmissionService({
    db: database.db,
    sessions,
    roster,
    sightings,
    connections: stubConnections({ professors: () => professors, league: () => connection.league }),
    gateway: () => noAttendance,
    staffGateway: (connectionId) => {
      jobGateways.push(connectionId);
      return upstream;
    },
    staffing,
    resolver: noResolver,
    now: () => clock,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      await onSleep?.(signal);
      clock = new Date(clock.getTime() + ms);
    },
    staffDelayMs: over.staffDelayMs ?? DELAY,
    log: { info: record('info'), warn: record('warn') },
  });
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  roster = createRosterService({ db: database.db });
  sightings = createSightingsService({ db: database.db });
  sessions = createSessionsService({ db: database.db, roster, sightings });
  upstream = new FakeStaffTools();
  upstream.tournaments = [tournament(T, { name: 'League Challenge', displayId: '26-10-1', organizer: ORGANIZER })];
  upstream.list(staffer(ORGANIZER, 'organizer', 'Olive Organizer', 'org-rec'));
  clock = new Date('2026-10-14T12:00:00Z');
  connection = { league: { id: GROUP, name: 'Card Shop', displayId: 'L5012' } };
  professors = [
    { id: 7, professorPlayerId: '0012345', professorName: 'Ash Ketchum', status: 'connected', ...HELD_BY_OWNER },
    { id: 1, professorPlayerId: ORGANIZER, professorName: 'Olive Organizer', status: 'connected', ...HELD_BY_OWNER },
  ];
  jobGateways = [];
  staffing = createStaffingService({
    db: database.db,
    roster,
    connections: stubConnections({ professors: () => professors, league: () => connection.league }),
    staffGateway: () => upstream,
    timeZone: TZ,
    now: () => clock,
  });
  sleeps = [];
  onSleep = undefined;
  logs = [];
  service = build();
});
afterEach(() => database.close());

/** The organizer wants `playerId` on the tournament in `role`; returns the assignment id. */
async function want(playerId: string, role = 'judge', name = `Staffer ${playerId}`): Promise<number> {
  const { assignment } = await staffing.addAssignment(L, DATE, { tournamentId: T, playerId: id(playerId), role, name }, OWNER);
  return assignment.id;
}

/** An assignment an earlier job applied: play-tools holds `recordId` for it. */
async function applied(playerId: string, role = 'judge', recordId = `ours-${playerId}`): Promise<number> {
  const a = await want(playerId, role);
  staffing.recordApplied(L, a, { recordId, role });
  upstream.list(staffer(playerId, role, '', recordId));
  return a;
}

/** Wants someone the add route would refuse (e.g. the organizer), written straight to the table. */
function wantDirectly(playerId: string, role = 'judge'): number {
  roster.ensurePlayers(L, [{ playerId: id(playerId), name: `Staffer ${playerId}` }]);
  const row = database.sqlite
    .prepare(
      `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, created_by, created_at)
       values (?, ?, ?, 'League Challenge · 26-10-1', ?, ?, 'organizer', 0) returning id`,
    )
    .get(L, DATE, T, playerId, role) as { id: number };
  return row.id;
}

async function apply(): Promise<SubmissionView> {
  upstream.resetLog();
  const { submissionId } = await service.applyStaff(L, DATE, { tournamentId: T, actor: OWNER });
  await service.idle();
  return service.get(L, submissionId);
}

const item = (view: SubmissionView, playerId: string) => view.items.find((i) => i.playerId === playerId);
const outcomes = (view: SubmissionView) => Object.fromEntries(view.items.map((i) => [i.playerId, i.outcome]));
const assignment = (assignmentId: number) =>
  database.sqlite.prepare('select state, record_id, applied_role, role from staff_assignment where id = ?').get(assignmentId) as
    | { state: string; record_id: string | null; applied_role: string | null; role: string }
    | undefined;
const history = () =>
  database.sqlite.prepare('select player_id, role, source from staff_history order by player_id').all() as {
    player_id: string;
    role: string;
    source: string;
  }[];
const submissions = () => (database.sqlite.prepare('select count(*) n from submission').get() as { n: number }).n;

async function refusal(promise: Promise<unknown>): Promise<StaffingError & { code: string }> {
  try {
    await promise;
  } catch (err) {
    return err as StaffingError & { code: string };
  }
  throw new Error('expected a refusal');
}

describe('a staff job (ADR-0007: plan → execute → reconcile)', () => {
  it('assigns each wanted staffer play-tools lacks, one call at a time, re-reading before each, and records what it did', async () => {
    const a = await want('00123');
    const b = await want('00456', 'scorekeeper');

    const view = await apply();

    expect(upstream.calls).toEqual(['read', 'read', 'assign 00123 judge', 'read', 'assign 00456 scorekeeper', 'read']);
    expect(upstream.writes[1]!.at - upstream.writes[0]!.at).toBeGreaterThanOrEqual(DELAY);
    expect(view).toMatchObject({
      kind: 'staff',
      date: DATE,
      playSessionId: T,
      playSessionLabel: 'Staff for League Challenge · 26-10-1',
      tournamentLabel: 'League Challenge · 26-10-1',
      status: 'succeeded',
      error: null,
      undoable: false,
      undoBlockedReason: 'not_undoable',
      counts: { added: 2, alreadyPresent: 0, failed: 0, skipped: 0, unrequested: 0 },
    });
    expect(item(view, '00123')).toEqual({
      playerId: '00123',
      displayName: 'Staffer 00123',
      origin: 'session',
      outcome: 'assigned',
      error: null,
      errorCode: null,
      suggestedPlayerId: null,
      recordId: upstream.recordOf('00123'),
      asStaff: false,
      removedBy: null,
      role: 'judge',
    });
    expect(assignment(a)).toMatchObject({ state: 'assigned', record_id: upstream.recordOf('00123'), applied_role: null });
    expect(assignment(b)).toMatchObject({ state: 'assigned', record_id: upstream.recordOf('00456') });
    expect(history()).toEqual([
      { player_id: '00123', role: 'judge', source: 'app' },
      { player_id: '00456', role: 'scorekeeper', source: 'app' },
    ]);
  });

  it("never sends the tournament's organizer: is_organizer, with no call naming them", async () => {
    wantDirectly(ORGANIZER);
    await want('00123');

    const view = await apply();

    expect(upstream.calls.filter((c) => c.includes(ORGANIZER))).toEqual([]);
    expect(outcomes(view)).toEqual({ [ORGANIZER]: 'is_organizer', '00123': 'assigned' });
    expect(view.status).toBe('succeeded');
  });

  it('never sends a player the tournament lists as a player: already_listed, saying how', async () => {
    await want('00123');
    upstream.list(playing('00123'));

    const view = await apply();

    expect(upstream.writes).toEqual([]);
    expect(item(view, '00123')).toMatchObject({ outcome: 'already_listed', error: 'Listed as a player' });
    expect(view.counts).toMatchObject({ added: 0, alreadyPresent: 1 });
  });

  it('adopts staff play-tools already lists in the wanted role: already_assigned, nothing sent, the record kept', async () => {
    const a = await want('00123');
    upstream.list(staffer('00123', 'judge', '', 'theirs'));

    const view = await apply();

    expect(upstream.writes).toEqual([]);
    expect(item(view, '00123')).toMatchObject({ outcome: 'already_assigned', recordId: 'theirs' });
    expect(assignment(a)).toMatchObject({ state: 'assigned', record_id: 'theirs' });
    expect(history()).toEqual([{ player_id: '00123', role: 'judge', source: 'app' }]);
  });

  it("never re-roles staff in another role on a record this app doesn't hold: already_listed", async () => {
    await want('00123');
    upstream.list(staffer('00123', 'scorekeeper', '', 'theirs'));

    const view = await apply();

    expect(upstream.writes).toEqual([]);
    expect(item(view, '00123')).toMatchObject({ outcome: 'already_listed', error: 'Listed as Scorekeeper' });
  });

  it('skips the call when play-tools starts listing the player between the plan and the call', async () => {
    await want('00123');
    upstream.onRead = (n) => {
      if (n === 2) upstream.list(playing('00123'));
    };

    const view = await apply();

    expect(upstream.writes).toEqual([]);
    expect(item(view, '00123')).toMatchObject({ outcome: 'already_listed', error: 'Listed as a player' });
  });

  it("sends a role change for this app's own record only, and clears the old role", async () => {
    const a = await applied('00123');
    await staffing.changeRole(L, DATE, a, 'headjudge', OWNER);

    const view = await apply();

    expect(upstream.writes.map((w) => w.call)).toEqual(['change ours-00123 headjudge']);
    expect(item(view, '00123')).toMatchObject({ outcome: 'role_changed', role: 'headjudge', recordId: 'ours-00123' });
    expect(assignment(a)).toMatchObject({ state: 'assigned', applied_role: null, role: 'headjudge' });
    expect(history()).toEqual([{ player_id: '00123', role: 'headjudge', source: 'app' }]);
  });

  it('re-roles and removes an adopted record like one it created', async () => {
    const a = await want('00123');
    const b = await want('00456');
    upstream.list(staffer('00123', 'judge', '', 'theirs-1'), staffer('00456', 'judge', '', 'theirs-2'));
    await apply();
    await staffing.changeRole(L, DATE, a, 'scorekeeper', OWNER);
    await staffing.removeAssignment(L, DATE, b, OWNER);

    const view = await apply();

    expect(upstream.writes.map((w) => w.call)).toEqual(['remove theirs-2', 'change theirs-1 scorekeeper']);
    expect(outcomes(view)).toEqual({ '00123': 'role_changed', '00456': 'removed' });
  });

  it('removes tombstoned records first, then role changes, then assigns', async () => {
    const gone = await applied('00111');
    const rerole = await applied('00222');
    await want('00333');
    await staffing.removeAssignment(L, DATE, gone, OWNER);
    await staffing.changeRole(L, DATE, rerole, 'scorekeeper', OWNER);

    const view = await apply();

    expect(upstream.writes.map((w) => w.call)).toEqual(['remove ours-00111', 'change ours-00222 scorekeeper', 'assign 00333 judge']);
    expect(outcomes(view)).toEqual({ '00111': 'removed', '00222': 'role_changed', '00333': 'assigned' });
    expect(assignment(gone)).toBeUndefined();
    expect(history()).toContainEqual({ player_id: '00111', role: 'judge', source: 'app' });
  });

  it('calls a tombstoned record play-tools no longer has already_removed, sends nothing and drops the row', async () => {
    const gone = await applied('00111');
    await staffing.removeAssignment(L, DATE, gone, OWNER);
    upstream.participants.set(T, upstream.on().filter((p) => p.playerId !== '00111'));

    const view = await apply();

    expect(upstream.writes).toEqual([]);
    expect(outcomes(view)).toEqual({ '00111': 'already_removed' });
    expect(assignment(gone)).toBeUndefined();
  });

  it('never touches staff entered in play-tools that nobody asked for, and gives them no item', async () => {
    await want('00123');
    upstream.list(staffer('00777', 'judge', 'Brock', 'theirs'));

    const view = await apply();

    expect(upstream.writes.map((w) => w.call)).toEqual(['assign 00123 judge']);
    expect(item(view, '00777')).toBeUndefined();
  });

  it('seeds the staff list from every read it makes', async () => {
    const seed = vi.spyOn(staffing, 'recordUpstreamStaff');
    await want('00123');
    upstream.list(staffer('00777', 'scorekeeper', 'Brock', 'theirs'));
    seed.mockClear();

    await apply();

    expect(seed).toHaveBeenCalledTimes(upstream.calls.filter((c) => c === 'read').length);
    expect(history()).toContainEqual({ player_id: '00777', role: 'scorekeeper', source: 'upstream' });
  });

  it('assigns afresh, after a re-read, when the record a role change targets is gone', async () => {
    const a = await applied('00123');
    await staffing.changeRole(L, DATE, a, 'scorekeeper', OWNER);
    upstream.onChange = () => {
      upstream.participants.set(T, upstream.on().filter((p) => p.playerId !== '00123'));
      return 'not_found';
    };

    const view = await apply();

    expect(upstream.writes.map((w) => w.call)).toEqual(['change ours-00123 scorekeeper', 'assign 00123 scorekeeper']);
    expect(upstream.calls.slice(-3)).toEqual(['read', 'assign 00123 scorekeeper', 'read']);
    expect(item(view, '00123')).toMatchObject({ outcome: 'assigned', recordId: upstream.recordOf('00123') });
    expect(assignment(a)).toMatchObject({ record_id: upstream.recordOf('00123'), applied_role: null });
  });

  it('fails a role change play-tools refuses and keeps the role play-tools holds', async () => {
    const a = await applied('00123');
    await staffing.changeRole(L, DATE, a, 'scorekeeper', OWNER);
    upstream.onChange = () => {
      throw new PokemonUpstreamError('unexpected_shape', 'Changing a staff role: play-tools answered 400.');
    };

    const view = await apply();

    expect(item(view, '00123')).toMatchObject({ outcome: 'failed', errorCode: 'unexpected_shape' });
    expect(assignment(a)).toMatchObject({ state: 'failed', applied_role: 'judge', record_id: 'ours-00123' });
    expect(view.status).toBe('failed');
  });

  it('fails an assigned staffer the closing re-read does not list', async () => {
    const a = await want('00123');
    upstream.onAssign = () => ({ status: 'assigned', recordId: 'never-stuck' });

    const view = await apply();

    expect(item(view, '00123')).toMatchObject({ outcome: 'failed', error: 'Not in play-tools after assigning.' });
    expect(assignment(a)).toMatchObject({ state: 'failed', record_id: null });
    expect(history()).toEqual([]);
  });

  it('fails a removal the closing re-read still lists', async () => {
    const gone = await applied('00111');
    await staffing.removeAssignment(L, DATE, gone, OWNER);
    upstream.onRemove = () => 'removed';

    const view = await apply();

    expect(item(view, '00111')).toMatchObject({ outcome: 'failed', error: 'Still in play-tools after removing.' });
    expect(assignment(gone)).toMatchObject({ state: 'removing' });
  });

  it('never writes sightings, session players or attendance, even when it removes someone who also played', async () => {
    sessions.addPlayer(L, DATE, { playerId: id('00111'), name: 'Played Too' });
    const gone = await applied('00111');
    await staffing.removeAssignment(L, DATE, gone, OWNER);
    const before = { sightings: sightings.on(L, DATE), session: sessions.getSession(L, DATE).players };

    await apply();

    expect(sightings.on(L, DATE)).toEqual(before.sightings);
    expect(sessions.getSession(L, DATE).players).toEqual(before.session);
  });
});

describe('when play-tools refuses a staffer (ADR-0007 decision 10)', () => {
  it('records an eligibility refusal as ineligible, with the code and why, and carries on', async () => {
    await want('00123');
    await want('00456');
    upstream.onAssign = (playerId) => (playerId === '00123' ? { status: 'refused', code: 'missing_certification' } : undefined);

    const view = await apply();

    expect(item(view, '00123')).toMatchObject({
      outcome: 'ineligible',
      errorCode: 'missing_certification',
      error: "missing_certification: Not certified for this role at this tournament's product",
      suggestedPlayerId: null,
    });
    expect(item(view, '00456')).toMatchObject({ outcome: 'assigned' });
    expect(view.status).toBe('partial');
    expect(view.counts).toMatchObject({ added: 1, failed: 1 });
  });

  it('suggests the id a merged player id was merged into, and never sends it', async () => {
    const a = await want('00123');
    upstream.onAssign = () => ({ status: 'refused', code: 'merged_player_id', suggestedPlayerId: id('09876') });

    const view = await apply();

    expect(item(view, '00123')).toMatchObject({ outcome: 'ineligible', errorCode: 'merged_player_id', suggestedPlayerId: '09876' });
    expect(item(view, '00123')!.error).toContain('09876');
    expect(upstream.calls.filter((c) => c.includes('09876'))).toEqual([]);
    expect(assignment(a)).toMatchObject({ state: 'failed' });
  });

  it('calls a duplicate refusal already_listed after a re-read, and never retries it', async () => {
    await want('00123');
    upstream.onAssign = () => {
      upstream.list(playing('00123'));
      return { status: 'refused', code: 'cannot_duplicate_participant' };
    };

    const view = await apply();

    expect(upstream.writes).toHaveLength(1);
    expect(item(view, '00123')).toMatchObject({ outcome: 'already_listed', error: 'Listed as a player' });
  });

  it('fails a 400 with no per-staffer reason (invalid) with its code, without resending', async () => {
    await want('00123');
    upstream.onAssign = () => ({ status: 'invalid', code: 'bad_request' });

    const view = await apply();

    expect(upstream.writes).toHaveLength(1);
    expect(item(view, '00123')).toMatchObject({ outcome: 'failed', errorCode: 'bad_request' });
  });

  it('fails an item the gateway refuses locally (a malformed id) as invalid_input, with nothing sent', async () => {
    await want('00123');
    upstream.onAssign = () => {
      throw new TypeError('Not a player id');
    };

    const view = await apply();

    expect(item(view, '00123')).toMatchObject({ outcome: 'failed', errorCode: 'invalid_input' });
  });
});

describe('when play-tools is down, throttling or locked', () => {
  it('re-reads after a 502 whose assign landed: assigned with the listed record, sent exactly once', async () => {
    await want('00123');
    upstream.onAssign = (playerId, role) => {
      upstream.list(staffer(playerId, role, '', 'landed'));
      throw new PokemonUpstreamError('unavailable', 'Assigning staff: play-tools answered 502.', { status: 502 });
    };

    const view = await apply();

    expect(upstream.writes).toHaveLength(1);
    expect(item(view, '00123')).toMatchObject({ outcome: 'assigned', recordId: 'landed' });
    expect(view.status).toBe('succeeded');
  });

  it('re-reads after a 502 that did not land and sends again, at most 3 times in all', async () => {
    await want('00123');
    upstream.onAssign = () => {
      throw new PokemonUpstreamError('unavailable', 'Assigning staff: play-tools answered 502.', { status: 502 });
    };

    const view = await apply();

    expect(upstream.writes).toHaveLength(3);
    expect(item(view, '00123')).toMatchObject({ outcome: 'failed', error: 'Assigning staff: play-tools answered 502.', errorCode: 'unavailable' });
  });

  it('succeeds on a resend after one 502 that did not land', async () => {
    await want('00123');
    upstream.onAssign = (_p, _r, n) => {
      if (n === 1) throw new PokemonUpstreamError('unavailable', '502', { status: 502 });
    };

    const view = await apply();

    expect(upstream.writes).toHaveLength(2);
    expect(item(view, '00123')).toMatchObject({ outcome: 'assigned' });
  });

  it('waits for Retry-After on a 429 before the next call', async () => {
    await want('00123');
    upstream.onAssign = (_p, _r, n) => {
      if (n === 1) throw new PokemonUpstreamError('rate_limited', 'Slow down.', { status: 429, retryAfterMs: 30_000 });
    };

    const view = await apply();

    expect(upstream.writes[1]!.at - upstream.writes[0]!.at).toBeGreaterThanOrEqual(30_000);
    expect(item(view, '00123')).toMatchObject({ outcome: 'assigned' });
  });

  it('fails an item whose pre-assign re-read keeps failing, without assigning it', async () => {
    await want('00123');
    upstream.onRead = (n) => {
      if (n >= 2 && n <= 4) throw new PokemonUpstreamError('unavailable', 'Reading staff: play-tools answered 503.', { status: 503 });
    };

    const view = await apply();

    expect(upstream.writes).toEqual([]);
    expect(item(view, '00123')).toMatchObject({ outcome: 'failed', errorCode: 'unavailable' });
  });

  it('stops on a 423: tournament_locked, the rest skipped, nothing more sent', async () => {
    await want('00123');
    await want('00456');
    upstream.onAssign = () => {
      throw new PokemonUpstreamError('tournament_locked', 'Assigning staff: the tournament is past its edit window in play-tools.', { status: 423 });
    };

    const view = await apply();

    expect(upstream.writes).toHaveLength(1);
    expect(view).toMatchObject({ status: 'failed', error: 'tournament_locked' });
    expect(item(view, '00123')).toMatchObject({ outcome: 'failed', errorCode: 'tournament_locked' });
    expect(item(view, '00456')).toMatchObject({ outcome: 'skipped' });
  });

  it('stops on a 403: forbidden, the rest skipped', async () => {
    await want('00123');
    await want('00456');
    upstream.onAssign = () => {
      throw new PokemonUpstreamError('forbidden', 'Assigning staff: play-tools refused the request (403).', { status: 403 });
    };

    const view = await apply();

    expect(view).toMatchObject({ status: 'failed', error: 'forbidden' });
    expect(outcomes(view)).toEqual({ '00123': 'failed', '00456': 'skipped' });
  });

  it('stops when the account needs reconnecting, with every unsent item skipped', async () => {
    await want('00123');
    upstream.onAssign = () => {
      throw new PokemonUpstreamError('needs_reconnect', 'Reconnect the Pokémon account in Settings.');
    };

    const view = await apply();

    expect(view.status).toBe('failed');
    expect(outcomes(view)).toEqual({ '00123': 'skipped' });
  });

  it('fails the whole job as unknown_tournament when the tournament is gone by the time it plans', async () => {
    await want('00123');
    // prepareApply reads the details first to find the organizer; the job's own read finds it gone.
    let reads = 0;
    upstream.onDetails = () => ++reads === 2 && upstream.gone.add(T);

    const view = await apply();

    expect(upstream.writes).toEqual([]);
    expect(view).toMatchObject({ status: 'failed', error: 'unknown_tournament' });
  });

  it('fails the job when play-tools is unreachable while planning', async () => {
    await want('00123');
    upstream.onRead = () => {
      throw new PokemonUpstreamError('needs_reconnect', 'Reconnect the Pokémon account in Settings.');
    };

    const view = await apply();

    expect(view.status).toBe('failed');
    expect(upstream.writes).toEqual([]);
  });

  it('fails an item whose local write-back fails, and the next apply heals it', async () => {
    const a = await want('00123');
    const write = vi.spyOn(staffing, 'recordApplied').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    const view = await apply();
    expect(item(view, '00123')).toMatchObject({ outcome: 'failed', errorCode: 'local_write_failed' });

    write.mockRestore();
    const again = await apply();
    expect(item(again, '00123')).toMatchObject({ outcome: 'already_assigned' });
    expect(assignment(a)).toMatchObject({ state: 'assigned', record_id: upstream.recordOf('00123') });
  });
});

describe('pacing (human-scale traffic)', () => {
  it('keeps writes at least NUXT_STAFF_DELAY_MS apart', async () => {
    await want('00111');
    await want('00222');
    await want('00333');

    await apply();

    const at = upstream.writes.map((w) => w.at);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(DELAY);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(DELAY);
  });

  it('never goes under 500 ms, whatever it is configured to', async () => {
    service = build({ staffDelayMs: 100 });
    await want('00111');
    await want('00222');

    await apply();

    expect(upstream.writes[1]!.at - upstream.writes[0]!.at).toBeGreaterThanOrEqual(500);
  });

  it('logs and reports progress with player ids, never names', async () => {
    await want('00123', 'judge', 'Ash Ketchum');

    const view = await apply();
    const events = service.events(L, view.id);

    expect(events.map((e) => e.type)).toEqual(['planned', 'staff_sent', 'reconciled', 'finished']);
    expect(events.find((e) => e.type === 'staff_sent')!.message).toBe('Assigned 00123 as Judge.');
    expect(JSON.stringify([events, logs])).not.toContain('Ash');
  });
});

describe('starting a staff job', () => {
  it("refuses a tournament that isn't one of the league's on the date, creating nothing", async () => {
    await want('00123');
    expect((await refusal(service.applyStaff(L, DATE, { tournamentId: 't-nope', actor: OWNER }))).code).toBe('unknown_tournament');
    expect(submissions()).toBe(0);
  });

  it('refuses a tournament past its edit window', async () => {
    await want('00123');
    upstream.tournaments = [tournament(T, { editableUntil: new Date(clock.getTime() - 1), organizer: ORGANIZER })];
    expect((await refusal(service.applyStaff(L, DATE, { tournamentId: T, actor: OWNER }))).code).toBe('tournament_locked');
    expect(submissions()).toBe(0);
  });

  it('refuses a tournament with no assignments', async () => {
    expect((await refusal(service.applyStaff(L, DATE, { tournamentId: T, actor: OWNER }))).code).toBe('nothing_to_apply');
  });

  it('refuses an assignment holding a role play-tools does not offer', async () => {
    wantDirectly('00123', 'organizer');
    expect((await refusal(service.applyStaff(L, DATE, { tournamentId: T, actor: OWNER }))).code).toBe('unknown_role');
  });

  it('refuses while another job holds the league’s lease', async () => {
    await want('00123');
    let release!: () => void;
    // Hold the job's own read of the tournament (prepareApply's comes first).
    let reads = 0;
    upstream.onDetails = () => {
      if (++reads < 2) return undefined;
      upstream.onDetails = undefined;
      return new Promise<void>((r) => (release = r));
    };
    const first = await service.applyStaff(L, DATE, { tournamentId: T, actor: OWNER });

    expect((await refusal(service.applyStaff(L, DATE, { tournamentId: T, actor: OWNER }))).code).toBe('submission_running');

    release();
    await service.idle();
    expect(service.get(L, first.submissionId).status).not.toBe('running');
  });

  it('refuses once shutting down', async () => {
    await want('00123');
    await service.shutdown();
    expect((await refusal(service.applyStaff(L, DATE, { tournamentId: T, actor: OWNER }))).code).toBe('shutting_down');
  });

  it('is never undoable', async () => {
    await want('00123');
    const view = await apply();
    expect((await refusal(service.undo(L, view.id, OWNER))).code).toBe('not_undoable');
  });
});

describe('retry, crash and shutdown', () => {
  it('retries a partial job as a new staff job that re-plans and sends nothing for who is assigned', async () => {
    await want('00123');
    await want('00456');
    upstream.onAssign = (playerId) => (playerId === '00456' ? { status: 'refused', code: 'missing_certification' } : undefined);
    const first = await apply();
    upstream.onAssign = undefined;
    upstream.resetLog();

    const { submissionId } = await service.retry(L, first.id, OWNER);
    await service.idle();
    const retry = service.get(L, submissionId);

    expect(retry).toMatchObject({ kind: 'staff', retryOf: first.id, playSessionId: T, status: 'succeeded' });
    expect(upstream.writes.map((w) => w.call)).toEqual(['assign 00456 judge']);
    expect(outcomes(retry)).toEqual({ '00123': 'already_assigned', '00456': 'assigned' });
  });

  it('marks a staff job a crash left running interrupted, skips its unsent items and frees the lease', async () => {
    await want('00123');
    const row = database.sqlite
      .prepare(
        `insert into submission (league_id, session_date, play_session_id, play_session_label, started_by, started_at, status, kind)
         values (?, ?, ?, 'Staff for League Challenge', 'o', 0, 'running', 'staff') returning id`,
      )
      .get(L, DATE, T) as { id: number };
    database.sqlite
      .prepare("insert into submission_item (submission_id, player_id, origin, outcome, role) values (?, '00123', 'session', 'pending', 'judge')")
      .run(row.id);
    database.sqlite.prepare('insert into submission_lock (league_id, submission_id, expires_at) values (?, ?, ?)').run(L, row.id, clock.getTime() + 60_000);

    expect(service.recoverInterrupted()).toBe(1);

    expect(service.get(L, row.id)).toMatchObject({ status: 'interrupted' });
    expect(outcomes(service.get(L, row.id))).toEqual({ '00123': 'skipped' });
    expect(database.sqlite.prepare('select count(*) n from submission_lock').get()).toEqual({ n: 0 });
  });

  it('stops between calls on shutdown, as interrupted, keeping what it already did', async () => {
    const a = await want('00111');
    await want('00222');
    onSleep = async (signal) => {
      void service.shutdown();
      throw signal.reason;
    };

    const view = await apply();

    expect(upstream.writes.map((w) => w.call)).toEqual(['assign 00111 judge']);
    expect(view.status).toBe('interrupted');
    expect(outcomes(view)).toEqual({ '00111': 'assigned', '00222': 'skipped' });
    expect(assignment(a)).toMatchObject({ state: 'assigned', record_id: upstream.recordOf('00111') });
  });
});

describe('history', () => {
  it('lists a staff job with its tournament label and staff counts', async () => {
    await want('00123');
    await want('00456');
    upstream.list(playing('00456'));
    await apply();

    expect(service.list(L, { date: DATE })).toEqual([
      expect.objectContaining({
        kind: 'staff',
        playSessionLabel: 'Staff for League Challenge · 26-10-1',
        tournamentLabel: 'League Challenge · 26-10-1',
        counts: { added: 1, alreadyPresent: 1, failed: 0, skipped: 0, unrequested: 0 },
        undoable: false,
      }),
    ]);
  });
});

describe('the professor a staff job runs as (#75)', () => {
  it("records and runs as the tournament's organizer, not the league's submitting professor", async () => {
    await want('500');
    const view = await apply();
    expect(view.professor).toEqual({ playerId: ORGANIZER, name: 'Olive Organizer' });
    expect(view.status).toBe('succeeded');
    expect(jobGateways.length).toBeGreaterThan(0);
    expect(new Set(jobGateways)).toEqual(new Set([1]));
  });

  it('stops failed with needs_reconnect, sending nothing through anyone else, when the organizer needs a reconnect as it runs', async () => {
    await want('500');
    upstream.resetLog();
    // The job's own read of the tournament finds the organizer's login refused (prepareApply read it first).
    let details = 0;
    upstream.onDetails = () => {
      if (++details === 2) {
        professors = professors.map((p) => (p.id === 1 ? { ...p, status: 'needs_reconnect' } : p));
        throw new PokemonUpstreamError('needs_reconnect', 'Reconnect Olive in Settings.');
      }
    };

    const view = await apply();
    expect(view).toMatchObject({ status: 'failed', error: expect.stringContaining('Reconnect') });
    expect(upstream.writes).toEqual([]);
    expect(new Set(jobGateways)).toEqual(new Set([1]));
  });

  it('refuses a retry with organizer_not_connected once the organizer has disconnected, starting nothing', async () => {
    await want('500');
    upstream.onAssign = () => ({ status: 'refused', code: 'missing_certification' });
    const first = await apply();
    professors = professors.filter((p) => p.id !== 1);

    await expect(service.retry(L, first.id, OWNER)).rejects.toMatchObject({ code: 'organizer_not_connected' });
    expect(service.list(L).filter((s) => s.kind === 'staff')).toHaveLength(1);
  });

  it('runs a retry as whoever organizes the tournament now', async () => {
    await want('500');
    upstream.onAssign = () => ({ status: 'refused', code: 'missing_certification' });
    const first = await apply();
    upstream.onAssign = undefined;
    professors = [...professors, { id: 2, professorPlayerId: '0000222', professorName: 'Brock Harrison', status: 'connected', ...HELD_BY_OWNER }];
    upstream.tournaments = [tournament(T, { name: 'League Challenge', displayId: '26-10-1', organizer: '0000222' })];
    jobGateways = [];

    const { submissionId } = await service.retry(L, first.id, OWNER);
    await service.idle();
    expect(service.get(L, submissionId).professor).toEqual({ playerId: '0000222', name: 'Brock Harrison' });
    expect(new Set(jobGateways)).toEqual(new Set([2]));
  });
});
