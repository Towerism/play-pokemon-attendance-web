import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerId } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { createMetricsService } from '../metrics/metrics';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { ActingConnection } from '../pokemon/connection';
import type {
  AttendanceRecord,
  DateRange,
  League,
  PlaySession,
  PlaySessionStatus,
  Tournament,
  TournamentDetails,
  TournamentParticipant,
} from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { type SessionsService, createSessionsService } from '../sessions/service';
import { type StaffingService, createStaffingService } from '../staffing/service';
import { GROUP, ROLES, playing, staffer, tournament } from '../staffing/test-helpers';
import { SubmissionError } from './errors';
import type { PlaySessionResolver } from './resolve';
import { type SubmissionService, type SubmissionView, createSubmissionService } from './service';
import { HELD_BY_OWNER, OWNER, stubConnections } from '../pokemon/test-connections';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
const ORGANIZER = '9999991';
const id = (s: string) => s as PlayerId;

/**
 * The tournaments one professor organizes, with everyone each one lists
 * (spike S6). An import only reads; every write rejects.
 */
class FakeTournaments {
  tournaments: TournamentDetails[] = [];
  participants = new Map<string, TournamentParticipant[]>();
  leagues: League[] = [{ id: GROUP, name: 'Card Shop', displayId: 'L5012', canSubmit: true }];
  /** Every call, in order: `leagues`, `list` or `read <tournament>`. */
  calls: string[] = [];
  onRead: ((tournamentId: string, n: number) => unknown) | undefined;
  /** While set, every call waits for it: holds an import mid-run. */
  gate: Promise<void> | undefined;
  private reads = 0;

  /** A tournament with the organizer's own record and `people`. */
  add(t: TournamentDetails, ...people: TournamentParticipant[]): void {
    this.tournaments.push(t);
    this.participants.set(t.id, [staffer(t.organizerPlayerId, 'organizer', 'Olive Organizer', `org-${t.id}`), ...people]);
  }

  listStaffRoles = () => ROLES;

  private async call<T>(run: () => T): Promise<T> {
    await this.gate;
    return run();
  }

  listLeagues(): Promise<League[]> {
    this.calls.push('leagues');
    return this.call(() => [...this.leagues]);
  }

  listTournaments(_range?: DateRange): Promise<Tournament[]> {
    this.calls.push('list');
    return this.call(() => this.tournaments.map(({ organizerPlayerId: _o, ...t }) => t));
  }

  listTournamentParticipants(tournamentId: string): Promise<TournamentParticipant[]> {
    this.calls.push(`read ${tournamentId}`);
    return this.call(() => {
      this.onRead?.(tournamentId, ++this.reads);
      return [...(this.participants.get(tournamentId) ?? [])];
    });
  }

  getTournament(): Promise<TournamentDetails> {
    return Promise.reject(new Error('an import never reads tournament details'));
  }

  assignStaff(): Promise<never> {
    return Promise.reject(new Error('an import never writes to play-tools'));
  }

  changeStaffRole(): Promise<never> {
    return Promise.reject(new Error('an import never writes to play-tools'));
  }

  unassignStaff(): Promise<never> {
    return Promise.reject(new Error('an import never writes to play-tools'));
  }
}

/**
 * The league's play sessions and who attended each (spikes S3, S4), as a
 * connected member of the league sees them. An import only reads; every write rejects.
 */
class FakeSessions {
  sessions: PlaySession[] = [];
  records = new Map<string, AttendanceRecord[]>();
  /** Every call, in order: `sessions <group> <status>` or `attendance <group> <session>`. */
  calls: string[] = [];
  onList: ((status: PlaySessionStatus) => unknown) | undefined;
  onRead: ((sessionId: string) => unknown) | undefined;

  add(s: PlaySession, ...people: AttendanceRecord[]): void {
    this.sessions.push(s);
    this.records.set(s.id, people);
  }

  /** As the adapter: each status in turn, stopping at the first that lists any. */
  async listPlaySessions(
    groupId: string,
    range: DateRange,
    statuses: readonly PlaySessionStatus[] = ['active', 'complete', 'pending'],
  ): Promise<PlaySession[]> {
    for (const status of statuses) {
      this.calls.push(`sessions ${groupId} ${status}`);
      this.onList?.(status);
      const found = this.sessions.filter((s) => s.status === status && s.startsAt >= range.from && s.startsAt < range.to);
      if (found.length > 0) return found;
    }
    return [];
  }

  async listAttendance(groupId: string, sessionId: string): Promise<AttendanceRecord[]> {
    this.calls.push(`attendance ${groupId} ${sessionId}`);
    this.onRead?.(sessionId);
    return [...(this.records.get(sessionId) ?? [])];
  }

  addAttendanceBulk(): Promise<never> {
    return Promise.reject(new Error('an import never adds attendance'));
  }

  removeAttendance(): Promise<never> {
    return Promise.reject(new Error('an import never removes attendance'));
  }
}

/** A past play session of the league; open play unless told otherwise. */
function session(sessionId: string, startsAt: string, status: PlaySessionStatus = 'complete'): PlaySession {
  const start = new Date(startsAt);
  return { id: sessionId, type: 'open_play', products: ['tcg'], startsAt: start, endsAt: null, editableUntil: new Date(start.getTime() + 7 * 86_400_000), status };
}

/** A player's attendance record. */
const attended = (playerId: string, name = ''): AttendanceRecord => ({ recordId: `r-${playerId}`, playerId: id(playerId), isPlayer: true, name });
/** A staff record, like the session creator's hidden organizer record (S4). */
const staffed = (playerId: string, name = ''): AttendanceRecord => ({ recordId: `s-${playerId}`, playerId: id(playerId), isPlayer: false, name });

let database: OpenDatabase;
let roster: RosterService;
let sightings: SightingsService;
let sessions: SessionsService;
let staffing: StaffingService;
let upstream: FakeTournaments;
/** The league's play sessions, as a connected member of the league sees them. */
let league: FakeSessions;
/** The connections whose attendance gateway the service asked for. */
let gatewayConnections: number[];
/** The league's chosen activity group (ADR-0015 §3), or none. */
let connection: { league: { id: string; name: string; displayId: string | null } | null };
let professors: ActingConnection[];
/** Play-tools as each connection sees it; a connection with no entry sees `upstream`. */
let asConnection: Map<number, FakeTournaments>;
let clock: Date;
let sleeps: number[];
let onSleep: ((signal: AbortSignal) => Promise<void> | void) | undefined;
let logs: { level: string; message: string; fields: unknown }[];
let service: SubmissionService;

const noResolver: PlaySessionResolver = {
  resolve: () => Promise.reject(new Error('an import never resolves play sessions')),
  find: () => Promise.reject(new Error('an import never resolves play sessions')),
};

function build(): SubmissionService {
  const record = (level: string) => (message: string, fields?: unknown) => logs.push({ level, message, fields });
  return createSubmissionService({
    db: database.db,
    sessions,
    roster,
    sightings,
    connections: stubConnections({ professors: () => professors, league: () => connection.league }),
    gateway: (connectionId) => {
      gatewayConnections.push(connectionId);
      return league;
    },
    staffGateway: (connectionId) => asConnection.get(connectionId ?? 0) ?? upstream,
    staffing,
    resolver: noResolver,
    timeZone: TZ,
    now: () => clock,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      await onSleep?.(signal);
      clock = new Date(clock.getTime() + ms);
    },
    log: { info: record('info'), warn: record('warn') },
  });
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  roster = createRosterService({ db: database.db });
  sightings = createSightingsService({ db: database.db });
  sessions = createSessionsService({ db: database.db, roster, sightings });
  upstream = new FakeTournaments();
  league = new FakeSessions();
  gatewayConnections = [];
  // 21:00 in Chicago on the 13th is already the 14th in UTC.
  clock = new Date('2026-10-14T02:00:00Z');
  connection = { league: { id: GROUP, name: 'Card Shop', displayId: 'L5012' } };
  professors = [{ id: 1, professorPlayerId: ORGANIZER, professorName: 'Olive Organizer', status: 'connected', ...HELD_BY_OWNER }];
  asConnection = new Map();
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

/** Starts a player import and waits for it to finish. */
async function importPlayers(): Promise<SubmissionView> {
  const { submissionId } = await service.importPlayers(L, OWNER);
  await service.idle();
  return service.get(L, submissionId);
}

/** The league's players, id → name. */
const leaguePlayers = () => Object.fromEntries(roster.listPlayers(L).map((p) => [p.playerId, p.displayName]));

describe('importing players from play-tools', () => {
  it("adds every tournament's players to the league, not its staff, as a player_import job", async () => {
    upstream.add(tournament('t-1'), playing('0000100', 'Ash Ketchum'), playing('0000200', 'Brock Harrison'), staffer('0000900', 'judge', 'Sam Staff'));
    upstream.add(tournament('t-2'), playing('0000300', 'Cilan Dent'), playing('0000100', 'Ash Ketchum'));

    const view = await importPlayers();

    expect(view).toMatchObject({
      kind: 'player_import',
      date: '2026-10-13',
      playSessionId: '',
      playSessionLabel: 'Player import',
      startedBy: 'organizer',
      professor: null,
      status: 'succeeded',
      error: null,
    });
    expect(leaguePlayers()).toEqual({ '0000100': 'Ash Ketchum', '0000200': 'Brock Harrison', '0000300': 'Cilan Dent' });
    expect(view.playerImport).toEqual({
      tournamentsTotal: 2,
      tournamentsRead: 2,
      tournamentsFailed: 0,
      sessionsTotal: 0,
      sessionsRead: 0,
      sessionsFailed: 0,
      sessionsError: null,
      playersFound: 3,
      newPlayers: [
        { playerId: '0000100', name: 'Ash Ketchum' },
        { playerId: '0000200', name: 'Brock Harrison' },
        { playerId: '0000300', name: 'Cilan Dent' },
      ],
    });
    expect(view.staffImport).toBeUndefined();
  });

  it("adds the players of the league's past play sessions, not their staff", async () => {
    league.add(session('s-1', '2026-10-07T23:00:00Z'), staffed(ORGANIZER, 'Olive Organizer'), attended('0000500', 'Iris Drake'), staffed('0000900', 'Sam Staff'));
    league.add(session('s-2', '2026-09-30T23:00:00Z'), attended('0000600', 'Misty Waterflower'));

    const view = await importPlayers();

    expect(view.status).toBe('succeeded');
    expect(leaguePlayers()).toEqual({ '0000500': 'Iris Drake', '0000600': 'Misty Waterflower' });
    expect(view.items.map((i) => [i.playerId, i.origin, i.outcome])).toEqual([
      ['0000500', 'upstream', 'new_player'],
      ['0000600', 'upstream', 'new_player'],
    ]);
  });

  it("lists every status on its own, reads each past session once, and leaves out one that hasn't started", async () => {
    league.add(session('done', '2026-10-07T23:00:00Z', 'complete'), attended('0000501'));
    league.add(session('open', '2026-10-13T23:00:00Z', 'active'), attended('0000502'));
    league.add(session('never-started', '2026-09-30T23:00:00Z', 'pending'), attended('0000503'));
    // Its status changed between the listings: play-tools lists it twice.
    league.add(session('moved', '2026-10-01T23:00:00Z', 'complete'), attended('0000504'));
    league.sessions.push({ ...league.sessions.at(-1)!, status: 'active' });
    // Starts exactly when the import does, and tomorrow.
    league.add(session('now', clock.toISOString(), 'pending'), attended('0000505'));
    league.add(session('tomorrow', '2026-10-14T23:00:00Z', 'pending'), attended('0000506'));

    await importPlayers();

    expect(league.calls).toEqual([
      `sessions ${GROUP} complete`,
      `sessions ${GROUP} active`,
      `sessions ${GROUP} pending`,
      `attendance ${GROUP} never-started`,
      `attendance ${GROUP} moved`,
      `attendance ${GROUP} done`,
      `attendance ${GROUP} open`,
    ]);
    expect(Object.keys(leaguePlayers()).sort()).toEqual(['0000501', '0000502', '0000503', '0000504']);
  });

  it("reads the sessions as a connected member of the league, in the league's activity group", async () => {
    connection = { ...connection, league: { ...connection.league!, id: 'group-9' } };
    professors = [
      { ...professors[0]!, membership: 'unknown' },
      { id: 2, professorPlayerId: '0000999', professorName: 'Rowan Reader', status: 'connected', ...HELD_BY_OWNER, canSubmit: false },
    ];
    league.add(session('s-1', '2026-10-07T23:00:00Z'), attended('0000500'));

    await importPlayers();

    expect(gatewayConnections).toEqual([2]);
    expect(league.calls).toContain('attendance group-9 s-1');
  });

  it("keeps a local name for a session's player, and adds one play-tools gives no name with an empty name", async () => {
    roster.ensurePlayers(L, [{ playerId: id('0000100'), name: 'Ash K.' }]);
    league.add(session('s-1', '2026-10-07T23:00:00Z'), attended('0000100', 'Ash Ketchum'), attended('0000700'));

    const view = await importPlayers();

    expect(leaguePlayers()).toEqual({ '0000100': 'Ash K.', '0000700': '' });
    expect(Object.fromEntries(view.items.map((i) => [i.playerId, i.outcome]))).toEqual({ '0000100': 'found', '0000700': 'new_player' });
  });

  it('has one item for a player a tournament and two sessions list, new to the league for the whole import', async () => {
    upstream.add(tournament('t-1'), playing('0000300', 'Cilan Dent'));
    league.add(session('s-1', '2026-10-07T23:00:00Z'), attended('0000300', 'Cilan Dent'));
    league.add(session('s-2', '2026-09-30T23:00:00Z'), attended('0000300', 'Cilan Dent'));

    const view = await importPlayers();

    expect(view.items.map((i) => [i.playerId, i.outcome])).toEqual([['0000300', 'new_player']]);
  });

  it('stores a padded player id from a session as the digits alone, once', async () => {
    roster.ensurePlayers(L, [{ playerId: id('0000800'), name: 'Good Id' }]);
    league.add(session('s-1', '2026-10-07T23:00:00Z'), attended(' 0000800 ', 'Good Id'));

    const view = await importPlayers();

    expect(leaguePlayers()).toEqual({ '0000800': 'Good Id' });
    expect(view.items.map((i) => [i.playerId, i.outcome])).toEqual([['0000800', 'found']]);
  });

  it("skips a session record whose player id isn't digits, logging the session and count but no name", async () => {
    league.add(session('s-1', '2026-10-07T23:00:00Z'), attended('abc', 'Bad Id'), attended('12-34', 'Also Bad'), attended('0000800', 'Good Id'));

    const view = await importPlayers();

    expect(view.status).toBe('succeeded');
    expect(leaguePlayers()).toEqual({ '0000800': 'Good Id' });
    expect(view.items.map((i) => i.playerId)).toEqual(['0000800']);
    expect(logs).toContainEqual({ level: 'warn', message: expect.stringContaining('skipped 2'), fields: expect.objectContaining({ sessionId: 's-1', skipped: 2 }) });
    expect(JSON.stringify(logs)).not.toMatch(/Bad Id|Also Bad|Good Id/);
  });

  it('keeps a local name, and only names a player the app could not name', async () => {
    roster.ensurePlayers(L, [{ playerId: id('0000100'), name: 'Ash K.' }, { playerId: id('0000200') }]);
    upstream.add(tournament('t-1'), playing('0000100', 'Ash Ketchum'), playing('0000200', 'Brock Harrison'));

    const view = await importPlayers();

    expect(leaguePlayers()).toEqual({ '0000100': 'Ash K.', '0000200': 'Brock Harrison' });
    expect(Object.fromEntries(view.items.map((i) => [i.playerId, i.outcome]))).toEqual({ '0000100': 'found', '0000200': 'found' });
    expect(view.playerImport?.newPlayers).toEqual([]);
  });

  it('adds a player play-tools gives no name with an empty name', async () => {
    upstream.add(tournament('t-1'), playing('0000100'));

    const view = await importPlayers();

    expect(leaguePlayers()).toEqual({ '0000100': '' });
    expect(view.playerImport?.newPlayers).toEqual([{ playerId: '0000100', name: '' }]);
  });

  it('has one item per player however many tournaments list them, new to the league for the whole import', async () => {
    upstream.add(tournament('t-1'), playing('0000300', 'Cilan Dent'), playing('0000300', 'Cilan Dent'));
    upstream.add(tournament('t-2'), playing('0000300', 'Cilan Dent'));
    upstream.add(tournament('t-3'), playing('0000300', 'Cilan Dent'));

    const view = await importPlayers();

    expect(view.items.map((i) => [i.playerId, i.origin, i.outcome])).toEqual([['0000300', 'upstream', 'new_player']]);
    expect(view.playerImport).toMatchObject({ tournamentsRead: 3, playersFound: 1 });
  });

  it('adds someone who staffs one tournament and plays in another, from their player record only', async () => {
    upstream.add(tournament('t-1'), staffer('0000400', 'judge', 'Dawn Berlitz'));
    upstream.add(tournament('t-2'), playing('0000400', 'Dawn Berlitz'));

    const view = await importPlayers();

    expect(view.items.map((i) => i.playerId)).toEqual(['0000400']);
    expect(database.sqlite.prepare('select count(*) n from staff_history').get()).toEqual({ n: 0 });
  });

  it('reads a tournament that lists only staff, adding nobody', async () => {
    upstream.add(tournament('t-1'), staffer('0000900', 'judge', 'Sam Staff'));

    const view = await importPlayers();

    expect(view.status).toBe('succeeded');
    expect(view.items).toEqual([]);
    expect(leaguePlayers()).toEqual({});
    expect(view.playerImport).toMatchObject({ tournamentsTotal: 1, tournamentsRead: 1, playersFound: 0 });
  });

  it('succeeds with nothing to count when the account organizes no tournaments', async () => {
    const view = await importPlayers();

    expect(view.status).toBe('succeeded');
    expect(view.playerImport).toEqual({
      tournamentsTotal: 0,
      tournamentsRead: 0,
      tournamentsFailed: 0,
      sessionsTotal: 0,
      sessionsRead: 0,
      sessionsFailed: 0,
      sessionsError: null,
      playersFound: 0,
      newPlayers: [],
    });
  });

  it('finds everyone again on a second run and changes no player', async () => {
    upstream.add(tournament('t-1'), playing('0000100', 'Ash Ketchum'), playing('0000200', 'Brock Harrison'));
    await importPlayers();
    const before = database.sqlite.prepare('select * from player_membership order by player_id').all();

    const second = await importPlayers();

    expect(second.items.map((i) => i.outcome)).toEqual(['found', 'found']);
    expect(database.sqlite.prepare('select * from player_membership order by player_id').all()).toEqual(before);
  });

  it('adds players only to the league it was started in', async () => {
    upstream.add(tournament('t-1'), playing('0000100', 'Ash Ketchum'));

    await importPlayers();

    expect(database.sqlite.prepare('select league_id, player_id from player_membership').all()).toEqual([{ league_id: L, player_id: '0000100' }]);
  });

  it('seeds a tournament of 1,000 players', async () => {
    const many = Array.from({ length: 1000 }, (_, n) => playing(String(n).padStart(7, '0'), `Player ${n}`));
    upstream.add(tournament('t-1'), ...many);

    const view = await importPlayers();

    expect(view.status).toBe('succeeded');
    expect(view.items).toHaveLength(1000);
    expect(roster.listPlayers(L)).toHaveLength(1000);
  });
});

describe('a league with years of play sessions', () => {
  it('seeds 500 past sessions of 40 players each, adding each player once', async () => {
    for (let n = 0; n < 500; n++) {
      const people = Array.from({ length: 40 }, (_, k) => attended(String(((n * 7 + k) % 2000) + 1).padStart(7, '0'), `Player ${k}`));
      league.add(session(`s-${n}`, new Date(Date.UTC(2016, 0, 1) + n * 7 * 86_400_000).toISOString()), ...people);
    }

    const view = await importPlayers();

    expect(view.status).toBe('succeeded');
    expect(view.playerImport).toMatchObject({ sessionsTotal: 500, sessionsRead: 500 });
    expect(view.items).toHaveLength(roster.listPlayers(L).length);
    expect(new Set(view.items.map((i) => i.playerId)).size).toBe(view.items.length);
  });
});

describe('what a player import leaves alone', () => {
  it('records no sighting, changes no regular, note or staff history, and leaves metrics as they were', async () => {
    const today = '2026-10-13' as never;
    roster.ensurePlayers(L, [{ playerId: id('0000100'), name: 'Ash K.' }]);
    roster.updatePlayer(L, id('0000100'), { isRegular: true, notes: 'Brings snacks' });
    sightings.record(L, '2026-10-06' as never, 'tdf', [id('0000100')]);
    upstream.add(tournament('t-1'), playing('0000100', 'Ash Ketchum'), playing('0000200', 'Brock Harrison'), staffer('0000900', 'judge'));
    league.add(session('s-1', '2026-10-07T23:00:00Z'), attended('0000100', 'Ash Ketchum'), attended('0000300', 'Cilan Dent'), staffed('0000900'));
    const metrics = createMetricsService({ db: database.db, roster, submissions: { timesSubmitted: () => new Map() } });
    const snapshot = () => ({
      sightings: database.sqlite.prepare('select * from sighting order by player_id').all(),
      staff: database.sqlite.prepare('select * from staff_history').all(),
      ash: database.sqlite.prepare("select is_regular, regular_since, notes from player_membership where player_id = '0000100'").get(),
      metrics: [...metrics.forLeague(L, today)],
    });
    const before = snapshot();

    await importPlayers();

    expect(snapshot()).toEqual(before);
    expect(roster.getPlayers(L, [id('0000200'), id('0000300')]).map((p) => p.isRegular)).toEqual([false, false]);
  });
});

/** The error a start was refused with. */
async function refusal(started: Promise<unknown>): Promise<{ code: string }> {
  const err = await started.then(
    () => expect.unreachable('expected the start to be refused'),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as { code: string };
}

const jobs = () => database.sqlite.prepare('select count(*) as n from submission').get() as { n: number };

describe('starting a player import', () => {
  beforeEach(() => upstream.add(tournament('t-1'), playing('0000100')));

  it.each([
    ['a staff import', () => service.importStaff(L, OWNER)],
    ['another player import', () => service.importPlayers(L, OWNER)],
  ])('is refused while %s holds the league, and creates nothing', async (_what, startFirst) => {
    let release!: () => void;
    upstream.gate = new Promise((r) => (release = r));
    await startFirst();

    const err = await refusal(service.importPlayers(L, OWNER));

    expect(err).toBeInstanceOf(SubmissionError);
    expect(err.code).toBe('submission_running');
    expect(jobs().n).toBe(1);
    release();
    await service.idle();
  });

  it('holds the league while it runs: a staff import is refused until it ends', async () => {
    let release!: () => void;
    upstream.gate = new Promise((r) => (release = r));
    await service.importPlayers(L, OWNER);

    expect((await refusal(service.importStaff(L, OWNER))).code).toBe('submission_running');

    release();
    await service.idle();
    expect(await service.importStaff(L, OWNER)).toEqual({ submissionId: expect.any(Number) });
    await service.idle();
  });

  it.each([
    ['not_connected', [] as ActingConnection[]],
    ['needs_reconnect', [{ id: 1, professorPlayerId: ORGANIZER, professorName: null, status: 'needs_reconnect' as const, ...HELD_BY_OWNER }]],
  ])('is refused with %s before any call', async (code, connected) => {
    professors = connected;

    const err = await refusal(service.importPlayers(L, OWNER));

    expect(err).toBeInstanceOf(PokemonUpstreamError);
    expect(err.code).toBe(code);
    expect(upstream.calls).toEqual([]);
    expect(jobs().n).toBe(0);
  });

  it('is refused with league_not_selected when no league is chosen', async () => {
    connection = { ...connection, league: null };

    expect((await refusal(service.importPlayers(L, OWNER))).code).toBe('league_not_selected');
    expect(jobs().n).toBe(0);
  });

  it('is refused with shutting_down once the app is stopping', async () => {
    await service.shutdown();

    expect((await refusal(service.importPlayers(L, OWNER))).code).toBe('shutting_down');
    expect(jobs().n).toBe(0);
  });
});

const down = () => new PokemonUpstreamError('unavailable', 'play-tools answered 503.', { status: 503 });
const refused = (status: 401 | 403) => new PokemonUpstreamError('forbidden', `Tournament participants: play-tools refused the request (${status}).`, { status });
const events = (submissionId: number) => service.events(L, submissionId).map((e) => e.type);

describe('reading tournaments', () => {
  beforeEach(() => {
    upstream.add(tournament('t-1'), playing('0000100', 'Ash Ketchum'));
    upstream.add(tournament('t-2'), playing('0000200', 'Brock Harrison'));
    upstream.add(tournament('t-3'), playing('0000300', 'Cilan Dent'));
  });

  it('skips a refused tournament, reads one again after two 503s, and ends partial', async () => {
    let t3Reads = 0;
    upstream.onRead = (t) => {
      if (t === 't-1') throw refused(403);
      if (t === 't-3' && ++t3Reads <= 2) throw down();
    };

    const view = await importPlayers();

    expect(view.status).toBe('partial');
    expect(view.error).toBeNull();
    expect(events(view.id)).toEqual(['sessions_planned', 'planned', 'tournament_failed', 'tournament_read', 'retrying', 'retrying', 'tournament_read', 'finished']);
    expect(leaguePlayers()).toEqual({ '0000200': 'Brock Harrison', '0000300': 'Cilan Dent' });
    expect(view.playerImport).toMatchObject({ tournamentsTotal: 3, tournamentsRead: 2, tournamentsFailed: 1, playersFound: 2 });
  });

  it('waits out a 429 for as long as play-tools asks', async () => {
    let first = true;
    upstream.onRead = (t) => {
      if (t === 't-2' && first) {
        first = false;
        throw new PokemonUpstreamError('rate_limited', 'Slow down.', { status: 429, retryAfterMs: 30_000 });
      }
    };

    const view = await importPlayers();

    expect(sleeps).toEqual([30_000]);
    expect(view.status).toBe('succeeded');
  });

  it('ends failed with the last code when no tournament could be read', async () => {
    upstream.onRead = () => {
      throw refused(403);
    };

    const view = await importPlayers();

    expect(view).toMatchObject({ status: 'failed', error: 'forbidden' });
    expect(leaguePlayers()).toEqual({});
  });

  it('logs ids, codes and counts, never a player name', async () => {
    upstream.onRead = (t) => {
      if (t === 't-1') throw refused(403);
    };

    await importPlayers();

    const logged = JSON.stringify(logs);
    expect(logged).toContain('Player import #');
    expect(logged).not.toMatch(/Ash|Brock|Cilan|Ketchum|Harrison|Dent/);
  });
});

describe('reading play sessions', () => {
  beforeEach(() => {
    upstream.add(tournament('t-1'), playing('0000100', 'Ash Ketchum'));
    league.add(session('s-1', '2026-09-23T23:00:00Z'), attended('0000201', 'Iris Drake'));
    league.add(session('s-2', '2026-09-30T23:00:00Z'), attended('0000202', 'Misty Waterflower'));
    league.add(session('s-3', '2026-10-07T23:00:00Z'), attended('0000203', 'Gary Oak'));
  });

  it.each([
    ['no connection is confirmed in the league yet', 'not_connected', () => (professors = [{ ...professors[0]!, membership: 'unknown' }])],
    [
      'the sessions are still down after three tries',
      'unavailable',
      () =>
        (league.onList = () => {
          throw down();
        }),
    ],
    [
      'play-tools refuses to list them',
      'forbidden',
      () =>
        (league.onList = () => {
          throw refused(403);
        }),
    ],
  ])('still reads the tournaments when %s, and says why no session was read', async (_why, code, arrange) => {
    arrange();

    const view = await importPlayers();

    expect(view).toMatchObject({ status: 'partial', error: null });
    expect(league.calls.filter((c) => c.startsWith('attendance'))).toEqual([]);
    expect(leaguePlayers()).toEqual({ '0000100': 'Ash Ketchum' });
    expect(events(view.id).filter((e) => e.startsWith('session'))).toEqual(['sessions_failed']);
    expect(view.playerImport).toMatchObject({ tournamentsTotal: 1, tournamentsRead: 1, sessionsTotal: 0, sessionsRead: 0, sessionsError: code });
  });

  it('reads no session when one status listing fails, even those the others listed', async () => {
    league.sessions[2] = { ...league.sessions[2]!, status: 'active' };
    league.onList = (status) => {
      if (status === 'active') throw down();
    };

    const view = await importPlayers();

    expect(league.calls).toEqual([`sessions ${GROUP} complete`, ...Array(3).fill(`sessions ${GROUP} active`)]);
    expect(view.playerImport).toMatchObject({ sessionsTotal: 0, sessionsError: 'unavailable' });
  });

  it("catches the league's connection going away as a sessions failure too", async () => {
    let release!: () => void;
    upstream.gate = new Promise((r) => (release = r));
    const { submissionId } = await service.importPlayers(L, OWNER);
    connection = { ...connection, league: null };
    release();
    await service.idle();

    expect(service.get(L, submissionId).playerImport).toMatchObject({ tournamentsRead: 1, sessionsError: 'league_not_selected' });
  });

  it('records a 401 on the listing as a rejected login, listing no other status, and a 403 as forbidden', async () => {
    league.onList = (status) => {
      if (status === 'complete') throw refused(401);
    };

    const rejected = await importPlayers();

    expect(league.calls).toEqual([`sessions ${GROUP} complete`]);
    expect(rejected.playerImport).toMatchObject({ sessionsError: 'login_rejected' });
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ code: 'login_rejected', upstreamCode: 'forbidden', status: 401 }) }),
    );

    league.calls = [];
    league.onList = () => {
      throw refused(403);
    };
    expect((await importPlayers()).playerImport).toMatchObject({ sessionsError: 'forbidden' });
  });

  it('ends failed as a rejected login when a league with no tournaments gets a 401 on its sessions', async () => {
    upstream.tournaments = [];
    league.onList = () => {
      throw refused(401);
    };

    expect(await importPlayers()).toMatchObject({ status: 'failed', error: 'login_rejected' });
  });

  it('ends failed with the sessions code when nothing at all could be read', async () => {
    upstream.tournaments = [];
    professors = [{ ...professors[0]!, membership: 'unknown' }];

    const view = await importPlayers();

    expect(view).toMatchObject({ status: 'failed', error: 'not_connected' });
  });

  it('skips a refused session, reads one again after two 503s, names the skipped one by its local date, and ends partial', async () => {
    let s3Reads = 0;
    league.onRead = (s) => {
      if (s === 's-1') throw refused(403);
      if (s === 's-3' && ++s3Reads <= 2) throw down();
    };

    const view = await importPlayers();

    expect(view).toMatchObject({ status: 'partial', error: null });
    expect(service.events(L, view.id).find((e) => e.type === 'session_failed')?.message).toBe('Could not read the play session on 2026-09-23: forbidden.');
    expect(leaguePlayers()).toEqual({ '0000100': 'Ash Ketchum', '0000202': 'Misty Waterflower', '0000203': 'Gary Oak' });
    expect(view.playerImport).toMatchObject({ sessionsTotal: 3, sessionsRead: 2, sessionsFailed: 1, sessionsError: null });
  });

  it.each([
    ['not_found', new PokemonUpstreamError('not_found', 'Gone.', { status: 404 })],
    ['unexpected_shape', new PokemonUpstreamError('unexpected_shape', 'Attendance: unexpected shape.')],
  ])('skips a session that is %s and goes on', async (code, err) => {
    league.onRead = (s) => {
      if (s === 's-2') throw err;
    };

    const view = await importPlayers();

    expect(view.playerImport).toMatchObject({ sessionsRead: 2, sessionsFailed: 1 });
    expect(service.events(L, view.id).find((e) => e.type === 'session_failed')?.message).toContain(code);
  });

  it('waits out a 429 on a session for as long as play-tools asks', async () => {
    let first = true;
    league.onRead = (s) => {
      if (s === 's-2' && first) {
        first = false;
        throw new PokemonUpstreamError('rate_limited', 'Slow down.', { status: 429, retryAfterMs: 5_000 });
      }
    };

    const view = await importPlayers();

    expect(sleeps).toEqual([5_000]);
    expect(view.playerImport).toMatchObject({ sessionsRead: 3 });
  });

  it('stops reading sessions after a 401, keeping what it read, and the progress still adds up', async () => {
    league.add(session('s-4', '2026-10-08T23:00:00Z'), attended('0000204'));
    league.add(session('s-5', '2026-10-09T23:00:00Z'), attended('0000205'));
    league.onRead = (s) => {
      if (s === 's-3') throw refused(401);
    };

    const view = await importPlayers();

    expect(league.calls.filter((c) => c.startsWith('attendance'))).toEqual([`attendance ${GROUP} s-1`, `attendance ${GROUP} s-2`, `attendance ${GROUP} s-3`]);
    expect(events(view.id).filter((e) => e.startsWith('session'))).toEqual(['sessions_planned', 'session_read', 'session_read', 'sessions_failed']);
    const last = service.events(L, view.id).at(-1)!;
    expect(last).toMatchObject({ type: 'finished', total: 4, done: 4 });
    expect(view).toMatchObject({ status: 'partial', error: null });
    expect(view.playerImport).toMatchObject({ sessionsTotal: 5, sessionsRead: 2, sessionsFailed: 0, sessionsError: 'login_rejected' });
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ code: 'login_rejected', upstreamCode: 'forbidden', status: 401 }) }),
    );
    expect(Object.keys(leaguePlayers()).sort()).toEqual(['0000100', '0000201', '0000202']);
  });

  it('stops when the app does, between two session reads, and its last progress counts what it read', async () => {
    let stopping: Promise<void> | undefined;
    league.onRead = (s) => {
      if (s === 's-2') stopping = service.shutdown();
    };

    const { submissionId } = await service.importPlayers(L, OWNER);
    await service.idle();
    await stopping;
    const view = service.get(L, submissionId);

    expect(view.status).toBe('interrupted');
    expect(league.calls).not.toContain(`attendance ${GROUP} s-3`);
    expect(service.events(L, submissionId).at(-1)).toMatchObject({ type: 'finished', done: 3, total: 4 });
    expect(view.playerImport).toMatchObject({ tournamentsRead: 1, sessionsTotal: 3, sessionsRead: 2 });
  });

  it('logs session ids and codes, never a player name', async () => {
    league.onRead = (s) => {
      if (s === 's-1') throw refused(403);
    };

    await importPlayers();

    expect(JSON.stringify(logs)).not.toMatch(/Iris|Misty|Gary|Drake|Waterflower|Oak/);
    expect(logs).toContainEqual(expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ sessionId: 's-1', code: 'forbidden' }) }));
  });
});

describe('progress, history and retry', () => {
  beforeEach(() => {
    upstream.add(tournament('t-1'), playing('0000100', 'Ash Ketchum'));
    upstream.add(tournament('t-2'), playing('0000200', 'Brock Harrison'));
  });

  it('is listed as a player_import that cannot be undone', async () => {
    const view = await importPlayers();

    expect(service.list(L).find((s) => s.id === view.id)).toMatchObject({ kind: 'player_import', undoable: false, undoBlockedReason: 'not_undoable' });
    expect((await refusal(service.undo(L, view.id, OWNER))).code).toBe('not_undoable');
  });

  it('finishes with what it read and found', async () => {
    const view = await importPlayers();

    expect(service.events(L, view.id).at(-1)).toMatchObject({
      type: 'finished',
      message: 'Player import succeeded: read 2 of 2 tournaments, found 2 players.',
      done: 2,
      total: 2,
    });
  });

  it('counts the tournaments and the play sessions together, and keeps them apart in the result', async () => {
    league.add(session('s-1', '2026-09-30T23:00:00Z'), attended('0000300', 'Cilan Dent'));
    league.add(session('s-2', '2026-10-07T23:00:00Z'), attended('0000100', 'Ash Ketchum'));
    league.add(session('s-3', '2026-10-13T23:00:00Z', 'active'));

    const view = await importPlayers();

    const all = service.events(L, view.id);
    expect(all.map((e) => e.type)).toEqual([
      'sessions_planned',
      'planned',
      'tournament_read',
      'tournament_read',
      'session_read',
      'session_read',
      'session_read',
      'finished',
    ]);
    expect(all[0]).toMatchObject({ total: 3 });
    expect(all[1]).toMatchObject({ message: '2 tournaments and 3 play sessions to read.', done: 0, total: 5 });
    expect(all.filter((e) => e.type === 'tournament_read').map((e) => e.message)).toEqual([
      'Read 1 of 5 tournaments and play sessions.',
      'Read 2 of 5 tournaments and play sessions.',
    ]);
    expect(all.filter((e) => e.type === 'session_read').map((e) => [e.done, e.total])).toEqual([
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
    expect(all.at(-1)).toMatchObject({ message: 'Player import succeeded: read 2 of 2 tournaments and 3 of 3 play sessions, found 3 players.', done: 5, total: 5 });
    expect(view.playerImport).toMatchObject({
      tournamentsTotal: 2,
      tournamentsRead: 2,
      tournamentsFailed: 0,
      sessionsTotal: 3,
      sessionsRead: 3,
      sessionsFailed: 0,
      sessionsError: null,
      playersFound: 3,
    });
  });

  it('shows no play sessions for an import from before they were read', async () => {
    const view = await importPlayers();
    database.sqlite.prepare("delete from submission_event where submission_id = ? and type = 'sessions_planned'").run(view.id);

    expect(service.get(L, view.id).playerImport).toMatchObject({
      tournamentsTotal: 2,
      tournamentsRead: 2,
      sessionsTotal: 0,
      sessionsRead: 0,
      sessionsFailed: 0,
      sessionsError: null,
    });
  });

  it('retries a partial import as a new player_import that reads everything again', async () => {
    upstream.onRead = (t) => {
      if (t === 't-2') throw down();
    };
    const first = await importPlayers();
    upstream.onRead = undefined;

    const { submissionId } = await service.retry(L, first.id, OWNER);
    await service.idle();
    const second = service.get(L, submissionId);

    expect(first.status).toBe('partial');
    expect(second).toMatchObject({ kind: 'player_import', retryOf: first.id, status: 'succeeded', playSessionLabel: 'Player import' });
    expect(Object.fromEntries(second.items.map((i) => [i.playerId, i.outcome]))).toEqual({ '0000100': 'found', '0000200': 'new_player' });
  });

  it("retries an import whose sessions failed, reading the league's sessions again", async () => {
    league.add(session('s-1', '2026-10-07T23:00:00Z'), attended('0000700', 'Iris Drake'));
    league.onList = () => {
      throw down();
    };
    const first = await importPlayers();
    league.onList = undefined;

    const { submissionId } = await service.retry(L, first.id, OWNER);
    await service.idle();

    expect(first.playerImport).toMatchObject({ sessionsError: 'unavailable' });
    expect(service.get(L, submissionId)).toMatchObject({ status: 'succeeded', playerImport: { sessionsRead: 1, sessionsError: null } });
    expect(leaguePlayers()).toHaveProperty('0000700', 'Iris Drake');
  });

  it('a running import found on boot becomes interrupted, and retrying it starts a new player_import', async () => {
    let release!: () => void;
    upstream.gate = new Promise((r) => (release = r));
    const { submissionId } = await service.importPlayers(L, OWNER);

    const rebooted = build();
    expect(rebooted.recoverInterrupted()).toBe(1);
    expect(rebooted.get(L, submissionId).status).toBe('interrupted');
    release();
    await service.idle();

    const retried = await rebooted.retry(L, submissionId, OWNER);
    await rebooted.idle();
    expect(rebooted.get(L, retried.submissionId)).toMatchObject({ kind: 'player_import', retryOf: submissionId, status: 'succeeded' });
  });
});

describe('importing from every connected professor', () => {
  const BROCK = '0000222';
  let brock: FakeTournaments;

  beforeEach(() => {
    brock = new FakeTournaments();
    asConnection.set(2, brock);
    professors = [...professors, { id: 2, professorPlayerId: BROCK, professorName: 'Brock Harrison', status: 'connected', ...HELD_BY_OWNER }];
    upstream.add(tournament('olives'), playing('0000100', 'Ash Ketchum'));
    brock.add(tournament('brocks', { organizer: BROCK }), playing('0000200', 'May Maple'));
  });

  it("reads each professor's tournaments as them, a shared one once, and records no single professor", async () => {
    const shared = tournament('shared');
    upstream.add(shared, playing('0000300', 'Max Maple'));
    brock.tournaments.push(shared);
    brock.participants.set('shared', upstream.participants.get('shared')!);

    const view = await importPlayers();

    expect(upstream.calls).toEqual(['leagues', 'list', 'read olives', 'read shared']);
    expect(brock.calls).toEqual(['leagues', 'list', 'read brocks']);
    expect(view).toMatchObject({ status: 'succeeded', professor: null });
    expect(Object.keys(leaguePlayers()).sort()).toEqual(['0000100', '0000200', '0000300']);
  });

  it("leaves out a tournament in a league the professor has left", async () => {
    upstream.add(tournament('gone', { groupId: 'old-league' }), playing('0000500', 'Gone Player'));

    await importPlayers();

    expect(upstream.calls).not.toContain('read gone');
    expect(leaguePlayers()).not.toHaveProperty('0000500');
  });

  it("stops reading a professor whose token is refused (401), and goes on with the others", async () => {
    upstream.add(tournament('olives-2'), playing('0000600', 'Iris Drake'));
    upstream.onRead = (t) => {
      if (t === 'olives') throw refused(401);
    };

    const view = await importPlayers();

    expect(upstream.calls).toEqual(['leagues', 'list', 'read olives']);
    expect(brock.calls).toContain('read brocks');
    expect(events(view.id)).toContain('professor_failed');
    // Only the session reads record a 401 as a rejected login (#195).
    expect(service.events(L, view.id).find((e) => e.type === 'professor_failed')?.message).toMatch(/: forbidden\.$/);
    expect(view.status).toBe('partial');
    expect(Object.keys(leaguePlayers())).toEqual(['0000200']);
  });
});
