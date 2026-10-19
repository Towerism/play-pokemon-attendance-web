import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { createSightingsService } from '../metrics/sightings';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import { createRosterService } from '../roster/service';
import { createSessionsService } from '../sessions/service';
import { type StaffingService, createStaffingService } from '../staffing/service';
import { OLIVE, staffer, stubPlayTools, tournament } from '../staffing/test-helpers';
import type { PlaySessionResolver } from './resolve';
import { type SubmissionService, createSubmissionService } from './service';
import { type StaffBatchView, batchStatus } from './staff-batch';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
const DATE = '2026-10-14' as SessionDate;
const DELAY = 1_000;
const BROCK = { id: 2, professorPlayerId: '8888882', professorName: 'Brock Harrison', status: 'connected' as const };
/** Olive's tournament, Brock's, and Olive's evening one, in start order. */
const FIRST = 'tA';
const SECOND = 'tB';
const THIRD = 'tC';

let database: OpenDatabase;
let stub: ReturnType<typeof stubPlayTools>;
let staffing: StaffingService;
let clock: Date;
let service: SubmissionService;

const noResolver: PlaySessionResolver = {
  resolve: () => Promise.reject(new Error('a staff batch never resolves play sessions')),
  find: () => Promise.reject(new Error('a staff batch never resolves play sessions')),
};
const noAttendance = {
  listPlaySessions: () => Promise.reject(new Error('this job never lists play sessions')),
  listAttendance: () => Promise.reject(new Error('a staff batch never reads attendance')),
  addAttendanceBulk: () => Promise.reject(new Error('a staff batch never adds attendance')),
  removeAttendance: () => Promise.reject(new Error('a staff batch never removes attendance')),
};

function build(): SubmissionService {
  const roster = createRosterService({ db: database.db });
  const sightings = createSightingsService({ db: database.db });
  return createSubmissionService({
    db: database.db,
    sessions: createSessionsService({ db: database.db, roster, sightings }),
    roster,
    sightings,
    connections: stub.connections,
    gateway: () => noAttendance,
    staffGateway: (connectionId) => stub.gateway(connectionId),
    staffing,
    resolver: noResolver,
    timeZone: TZ,
    now: () => clock,
    sleep: async (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    staffDelayMs: DELAY,
  });
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  stub = stubPlayTools();
  stub.addProfessor(BROCK);
  stub.state.tournaments = [
    tournament(FIRST, { name: 'TCG Cup', displayId: '26-10-1', organizer: OLIVE.professorPlayerId!, startsAt: new Date('2026-10-14T22:00:00Z') }),
    tournament(SECOND, { name: 'VGC Cup', displayId: '26-10-2', organizer: BROCK.professorPlayerId, startsAt: new Date('2026-10-14T23:00:00Z') }),
    tournament(THIRD, { name: 'GO Cup', displayId: '26-10-3', organizer: OLIVE.professorPlayerId!, startsAt: new Date('2026-10-15T01:00:00Z') }),
  ];
  for (const t of stub.state.tournaments) stub.state.participants.set(t.id, [staffer(t.organizerPlayerId, 'organizer', '', `org-${t.id}`)]);
  clock = new Date('2026-10-14T12:00:00Z');
  stub.state.clock = () => clock.getTime();
  const roster = createRosterService({ db: database.db });
  staffing = createStaffingService({
    db: database.db,
    roster,
    connections: stub.connections,
    staffGateway: (connectionId) => stub.gateway(connectionId),
    timeZone: TZ,
    now: () => clock,
  });
  service = build();
});
afterEach(() => database.close());

/** The organizer wants `playerId` on `tournamentId`. */
async function want(tournamentId: string, playerId: string, role = 'judge'): Promise<void> {
  await staffing.addAssignment(L, DATE, { tournamentId, playerId: playerId as PlayerId, role, name: `Staffer ${playerId}` }, 'organizer');
}

/** Wants one staffer on each tournament given, then forgets the calls that setting up made. */
async function wantOnEach(...tournamentIds: string[]): Promise<void> {
  for (const [i, t] of tournamentIds.entries()) await want(t, `0010${i}`);
  stub.state.calls = [];
  stub.state.callsAs = [];
  stub.state.writes = [];
}

async function runAll(tournamentIds: string[]): Promise<StaffBatchView> {
  const { batchId } = await service.applyStaffAll(L, DATE, { tournamentIds, startedBy: 'organizer' });
  await service.idle();
  return service.staffBatch(L, batchId);
}

/** A gate: calls matching `match` wait until `open()`; `reached` resolves when the first one arrives. */
function gate(match: (call: string) => boolean) {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const arrived = new Promise<void>((r) => (reached = r));
  stub.state.before = async (call) => {
    if (!match(call)) return;
    reached();
    await opened;
  };
  return { open, reached: arrived };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as { code: string }).code;
  }
  throw new Error('expected a refusal');
}

const rowsOf = (view: StaffBatchView) => view.rows.map((r) => ({ tournamentId: r.tournamentId, status: r.status }));
const staffJobs = () =>
  database.sqlite.prepare("select play_session_id, professor_player_id, status from submission where kind = 'staff' order by id").all() as {
    play_session_id: string;
    professor_player_id: string;
    status: string;
  }[];

describe('assigning staff for every tournament on a date', () => {
  it('runs one ordinary staff job per tournament, in the order asked (the staff list’s), each as its own organizer', async () => {
    await wantOnEach(FIRST, SECOND);

    const view = await runAll([SECOND, FIRST]);

    expect(view.status).toBe('succeeded');
    expect(rowsOf(view)).toEqual([
      { tournamentId: SECOND, status: 'succeeded' },
      { tournamentId: FIRST, status: 'succeeded' },
    ]);
    expect(staffJobs()).toEqual([
      { play_session_id: SECOND, professor_player_id: BROCK.professorPlayerId, status: 'succeeded' },
      { play_session_id: FIRST, professor_player_id: OLIVE.professorPlayerId, status: 'succeeded' },
    ]);
    expect(stub.state.writes.map((w) => [w.call, w.as])).toEqual([
      [`assign ${SECOND} 00101 judge`, BROCK.id],
      [`assign ${FIRST} 00100 judge`, OLIVE.id],
    ]);
  });

  it('shows each tournament with its label, organizer, job and counts once done', async () => {
    await wantOnEach(FIRST, SECOND);

    const view = await runAll([FIRST, SECOND]);

    expect(view).toMatchObject({ sessionDate: DATE, startedBy: 'organizer', finishedAt: clock });
    expect(view.rows[0]).toEqual({
      position: 0,
      tournamentId: FIRST,
      label: 'TCG Cup · 26-10-1',
      organizerName: 'Olive Organizer',
      status: 'succeeded',
      submissionId: expect.any(Number),
      progress: null,
      counts: { added: 1, alreadyPresent: 0, failed: 0, skipped: 0 },
      refusal: null,
    });
    expect(service.get(L, view.rows[1]!.submissionId!)).toMatchObject({ kind: 'staff', tournamentLabel: 'VGC Cup · 26-10-2', status: 'succeeded' });
  });

  it('keeps writes one at a time and at least NUXT_STAFF_DELAY_MS apart, across tournaments too', async () => {
    await want(FIRST, '00101');
    await want(FIRST, '00102');
    await want(SECOND, '00201');
    stub.state.writes = [];

    await runAll([FIRST, SECOND]);

    const at = stub.state.writes.map((w) => w.at);
    expect(at).toHaveLength(3);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(DELAY);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(DELAY);
    expect(stub.maxConcurrentCalls()).toBe(1);
  });

  it('holds the league’s lease from the first job to the last, refusing any other job in between', async () => {
    await wantOnEach(FIRST, SECOND);
    const second = gate((call) => call.startsWith('listTournaments') && stub.state.writes.length === 1);
    const { batchId } = await service.applyStaffAll(L, DATE, { tournamentIds: [FIRST, SECOND], startedBy: 'organizer' });
    await second.reached;

    expect(rowsOf(service.staffBatch(L, batchId))).toEqual([
      { tournamentId: FIRST, status: 'succeeded' },
      { tournamentId: SECOND, status: 'waiting' },
    ]);
    expect(await code(service.applyStaff(L, DATE, { tournamentId: FIRST, startedBy: 'organizer' }))).toBe('submission_running');
    expect(await code(service.applyStaffAll(L, DATE, { tournamentIds: [FIRST], startedBy: 'organizer' }))).toBe('submission_running');
    expect(await code(service.importStaff(L, 'organizer'))).toBe('submission_running');

    second.open();
    await service.idle();
    expect(service.staffBatch(L, batchId).status).toBe('succeeded');
    await expect(service.applyStaff(L, DATE, { tournamentId: FIRST, startedBy: 'organizer' })).resolves.toBeTruthy();
    await service.idle();
  });

  it('shows the running tournament with its job and progress, and the rest waiting', async () => {
    await wantOnEach(FIRST, SECOND);
    const write = gate((call) => call.startsWith('assignStaff'));
    const { batchId } = await service.applyStaffAll(L, DATE, { tournamentIds: [FIRST, SECOND], startedBy: 'organizer' });
    await write.reached;

    const view = service.staffBatch(L, batchId);
    expect(view.status).toBe('running');
    expect(view.rows[0]).toMatchObject({ status: 'running', submissionId: expect.any(Number), progress: { done: 0, total: 1 }, counts: null });
    expect(view.rows[1]).toMatchObject({ status: 'waiting', submissionId: null, progress: null });
    expect(service.runningStaffBatch(L, DATE)?.id).toBe(batchId);

    write.open();
    await service.idle();
    expect(service.runningStaffBatch(L, DATE)).toBeNull();
  });

  it('records a tournament refused at its turn as not started, with why, and goes on', async () => {
    await wantOnEach(FIRST, SECOND, THIRD);
    stub.addProfessor({ ...BROCK, status: 'needs_reconnect' });

    const view = await runAll([FIRST, SECOND, THIRD]);

    expect(rowsOf(view)).toEqual([
      { tournamentId: FIRST, status: 'succeeded' },
      { tournamentId: SECOND, status: 'not_started' },
      { tournamentId: THIRD, status: 'succeeded' },
    ]);
    expect(view.rows[1]).toMatchObject({ submissionId: null, refusal: { code: 'needs_reconnect', message: expect.any(String) } });
    expect(view.status).toBe('partial');
    expect(staffJobs().map((j) => j.play_session_id)).toEqual([FIRST, THIRD]);
  });

  it('records a tournament no connected professor has on the date as not started unknown_tournament', async () => {
    await wantOnEach(FIRST);

    const view = await runAll([FIRST, 'nope']);

    expect(view.rows[1]).toMatchObject({ tournamentId: 'nope', status: 'not_started', refusal: { code: 'unknown_tournament' } });
    expect(view.status).toBe('partial');
  });

  it('records a tournament whose staff were all removed meanwhile as not started nothing_to_apply', async () => {
    await wantOnEach(FIRST);

    const view = await runAll([FIRST, SECOND]);

    expect(view.rows[1]).toMatchObject({ status: 'not_started', refusal: { code: 'nothing_to_apply' } });
  });

  it('records a tournament locked by the time its turn comes as not started tournament_locked', async () => {
    await wantOnEach(FIRST, SECOND);
    stub.state.tournaments = stub.state.tournaments.map((t) => (t.id === SECOND ? { ...t, editableUntil: new Date('2026-10-01T00:00:00Z') } : t));

    const view = await runAll([FIRST, SECOND]);

    expect(view.rows[1]).toMatchObject({ status: 'not_started', refusal: { code: 'tournament_locked' } });
  });

  it('goes on after a tournament whose job fails', async () => {
    await wantOnEach(FIRST, SECOND);
    stub.state.failNextAs.set(`assignStaff@${OLIVE.id}`, new PokemonUpstreamError('tournament_locked', 'Locked.', { status: 423 }));

    const view = await runAll([FIRST, SECOND]);

    expect(rowsOf(view)).toEqual([
      { tournamentId: FIRST, status: 'failed' },
      { tournamentId: SECOND, status: 'succeeded' },
    ]);
    expect(view.status).toBe('partial');
  });

  it('records an unexpected error at a tournament’s turn as not started, and goes on', async () => {
    await wantOnEach(FIRST, SECOND);
    stub.state.before = (call, as) => {
      if (call.startsWith('listTournaments') && as === BROCK.id) throw new Error('disk full');
    };

    const view = await runAll([SECOND, FIRST]);

    expect(view.rows[0]).toMatchObject({ tournamentId: SECOND, status: 'not_started', refusal: { code: 'unexpected', message: 'disk full' } });
    expect(view.rows[1]).toMatchObject({ tournamentId: FIRST, status: 'succeeded' });
  });

  it('fails the batch, sending nothing, when no tournament can start', async () => {
    await wantOnEach(FIRST);
    stub.addProfessor({ ...OLIVE, status: 'needs_reconnect' });

    const view = await runAll([FIRST, 'nope']);

    expect(view.status).toBe('failed');
    expect(view.rows.map((r) => r.status)).toEqual(['not_started', 'not_started']);
    expect(stub.state.writes).toEqual([]);
    expect(staffJobs()).toEqual([]);
  });
});

describe('starting a batch', () => {
  it('refuses while another job holds the league’s lease, creating nothing', async () => {
    await wantOnEach(FIRST, SECOND);
    const write = gate((call) => call.startsWith('assignStaff'));
    await service.applyStaff(L, DATE, { tournamentId: FIRST, startedBy: 'organizer' });
    await write.reached;

    expect(await code(service.applyStaffAll(L, DATE, { tournamentIds: [SECOND], startedBy: 'organizer' }))).toBe('submission_running');
    expect(service.runningStaffBatch(L, DATE)).toBeNull();

    write.open();
    await service.idle();
  });

  it('refuses to start or show batches until a league is chosen, creating nothing', async () => {
    await wantOnEach(FIRST);
    const view = await runAll([FIRST]);
    stub.state.connection = { ...stub.state.connection, league: null };

    expect(await code(service.applyStaffAll(L, DATE, { tournamentIds: [FIRST], startedBy: 'organizer' }))).toBe('league_not_selected');
    expect(() => service.staffBatch(L, view.id)).toThrow(expect.objectContaining({ code: 'league_not_selected' }));
    expect(() => service.runningStaffBatch(L, DATE)).toThrow(expect.objectContaining({ code: 'league_not_selected' }));
    expect(staffJobs()).toHaveLength(1);
  });

  it('refuses once shutting down', async () => {
    await service.shutdown();

    expect(await code(service.applyStaffAll(L, DATE, { tournamentIds: [FIRST], startedBy: 'organizer' }))).toBe('shutting_down');
  });

  it("answers not_found for another league's batch or one that doesn't exist", async () => {
    await wantOnEach(FIRST);
    const view = await runAll([FIRST]);

    expect(() => service.staffBatch('another-league', view.id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(() => service.staffBatch(L, view.id + 1)).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('shutdown and boot recovery', () => {
  it('starts no further tournament once shutting down, and the next boot marks the batch and the rest interrupted', async () => {
    await wantOnEach(FIRST, SECOND);
    const write = gate((call) => call.startsWith('assignStaff'));
    const { batchId } = await service.applyStaffAll(L, DATE, { tournamentIds: [FIRST, SECOND], startedBy: 'organizer' });
    await write.reached;

    const stopping = service.shutdown();
    write.open();
    await stopping;
    expect(staffJobs().map((j) => j.play_session_id)).toEqual([FIRST]);

    const next = build();
    next.recoverInterrupted();
    const view = next.staffBatch(L, batchId);
    expect(view.status).toBe('interrupted');
    expect(view.finishedAt).not.toBeNull();
    expect(view.rows[1]).toMatchObject({ tournamentId: SECOND, status: 'interrupted' });
    await expect(next.applyStaffAll(L, DATE, { tournamentIds: [SECOND], startedBy: 'organizer' })).resolves.toBeTruthy();
    await next.idle();
  });
});

describe('shutdown between a tournament’s checks and its job', () => {
  it('starts no job once shutdown begins while the next tournament is being checked', async () => {
    await wantOnEach(FIRST, SECOND);
    const check = gate((call) => call.startsWith('getTournament') && stub.state.writes.length === 1);
    await service.applyStaffAll(L, DATE, { tournamentIds: [FIRST, SECOND], startedBy: 'organizer' });
    await check.reached;

    const stopping = service.shutdown();
    check.open();
    await stopping;

    expect(staffJobs().map((j) => j.play_session_id)).toEqual([FIRST]);
    expect(stub.state.writes).toHaveLength(1);
  });
});

describe('a batch’s status', () => {
  it.each([
    [['succeeded', 'succeeded'], 'succeeded'],
    [['succeeded', 'partial'], 'partial'],
    [['succeeded', 'failed'], 'partial'],
    [['succeeded', 'not_started'], 'partial'],
    [['partial', 'partial'], 'partial'],
    [['failed', 'not_started'], 'failed'],
    [['interrupted', 'not_started'], 'failed'],
    [['not_started'], 'failed'],
  ] as const)('rolls %j up to %s', (rows, status) => {
    expect(batchStatus(rows)).toBe(status);
  });
});
