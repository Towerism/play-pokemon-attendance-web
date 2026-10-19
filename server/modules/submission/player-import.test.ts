import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerId } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { createMetricsService } from '../metrics/metrics';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { ActingConnection } from '../pokemon/connection';
import type { DateRange, League, Tournament, TournamentDetails, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { type SessionsService, createSessionsService } from '../sessions/service';
import { type StaffingService, createStaffingService } from '../staffing/service';
import { GROUP, ROLES, playing, staffer, tournament } from '../staffing/test-helpers';
import { SubmissionError } from './errors';
import type { PlaySessionResolver } from './resolve';
import { type SubmissionService, type SubmissionView, createSubmissionService } from './service';
import { HELD_BY_OWNER, OWNER, stubConnections } from '../pokemon/test-helpers';

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

let database: OpenDatabase;
let roster: RosterService;
let sightings: SightingsService;
let sessions: SessionsService;
let staffing: StaffingService;
let upstream: FakeTournaments;
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
const noAttendance = {
  listAttendance: () => Promise.reject(new Error('an import never reads attendance')),
  addAttendanceBulk: () => Promise.reject(new Error('an import never adds attendance')),
  removeAttendance: () => Promise.reject(new Error('an import never removes attendance')),
};

function build(): SubmissionService {
  const record = (level: string) => (message: string, fields?: unknown) => logs.push({ level, message, fields });
  return createSubmissionService({
    db: database.db,
    sessions,
    roster,
    sightings,
    connections: stubConnections({ professors: () => professors, league: () => connection.league }),
    gateway: () => noAttendance,
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
      playersFound: 3,
      newPlayers: [
        { playerId: '0000100', name: 'Ash Ketchum' },
        { playerId: '0000200', name: 'Brock Harrison' },
        { playerId: '0000300', name: 'Cilan Dent' },
      ],
    });
    expect(view.staffImport).toBeUndefined();
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
    expect(view.playerImport).toEqual({ tournamentsTotal: 0, tournamentsRead: 0, tournamentsFailed: 0, playersFound: 0, newPlayers: [] });
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

describe('what a player import leaves alone', () => {
  it('records no sighting, changes no regular, note or staff history, and leaves metrics as they were', async () => {
    const today = '2026-10-13' as never;
    roster.ensurePlayers(L, [{ playerId: id('0000100'), name: 'Ash K.' }]);
    roster.updatePlayer(L, id('0000100'), { isRegular: true, notes: 'Brings snacks' });
    sightings.record(L, '2026-10-06' as never, 'tdf', [id('0000100')]);
    upstream.add(tournament('t-1'), playing('0000100', 'Ash Ketchum'), playing('0000200', 'Brock Harrison'), staffer('0000900', 'judge'));
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
    expect(roster.getPlayers(L, [id('0000200')])[0]).toMatchObject({ isRegular: false });
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
    ['needs_reconnect', [{ id: 1, professorPlayerId: ORGANIZER, professorName: null, status: 'needs_reconnect', ...HELD_BY_OWNER as const }]],
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
    expect(events(view.id)).toEqual(['planned', 'tournament_failed', 'tournament_read', 'retrying', 'retrying', 'tournament_read', 'finished']);
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
    expect(view.status).toBe('partial');
    expect(Object.keys(leaguePlayers())).toEqual(['0000200']);
  });
});
