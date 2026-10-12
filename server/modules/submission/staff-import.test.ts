import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import type { ConnectionView } from '../pokemon/connection';
import type { DateRange, Tournament, TournamentDetails, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import { type SessionsService, createSessionsService } from '../sessions/service';
import { type StaffingService, createStaffingService } from '../staffing/service';
import { GROUP, ROLES, playing, staffer, tournament } from '../staffing/test-helpers';
import { SubmissionError } from './errors';
import type { PlaySessionResolver } from './resolve';
import { type SubmissionService, type SubmissionView, createSubmissionService } from './service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
const ORGANIZER = '9999991';
const id = (s: string) => s as PlayerId;

/**
 * Every tournament the account organizes, in any league, with everyone each
 * one lists (spike S6). Read-only: an import never writes to play-tools.
 * Hooks run before each call and may throw.
 */
class FakeTournaments {
  tournaments: TournamentDetails[] = [];
  participants = new Map<string, TournamentParticipant[]>();
  /** Every call, in order: `list` or `read <tournament>`. */
  calls: string[] = [];
  onList: ((n: number) => unknown) | undefined;
  onRead: ((tournamentId: string, n: number) => unknown) | undefined;
  /** While set, every call waits for it: holds an import mid-run. */
  gate: Promise<void> | undefined;
  private inFlight = 0;
  maxInFlight = 0;
  private lists = 0;
  private reads = 0;

  /** A tournament the account organizes, with the organizer's own record and `people`. */
  add(t: TournamentDetails, ...people: TournamentParticipant[]): void {
    this.tournaments.push(t);
    this.participants.set(t.id, [staffer(t.organizerPlayerId, 'organizer', 'Olive Organizer', `org-${t.id}`), ...people]);
  }

  listStaffRoles = () => ROLES;

  private async call<T>(run: () => T): Promise<T> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.gate;
      await new Promise((r) => setTimeout(r, 1));
      return run();
    } finally {
      this.inFlight -= 1;
    }
  }

  listTournaments(range?: DateRange): Promise<Tournament[]> {
    this.calls.push(range ? 'list ranged' : 'list');
    return this.call(() => {
      this.onList?.(++this.lists);
      return this.tournaments.map(({ organizerPlayerId: _o, ...t }) => t);
    });
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
let connection: ConnectionView;
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
    connections: { getStatus: () => connection },
    gateway: () => noAttendance,
    staffGateway: () => upstream,
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
  connection = {
    status: 'connected',
    reason: null,
    connectedAt: clock,
    lastRefreshedAt: clock,
    league: { id: GROUP, name: 'Card Shop', displayId: 'L5012', canSubmit: true },
  };
  staffing = createStaffingService({
    db: database.db,
    roster,
    connections: { getStatus: () => connection },
    gateway: () => upstream,
    timeZone: TZ,
    now: () => clock,
  });
  sleeps = [];
  onSleep = undefined;
  logs = [];
  service = build();
});
afterEach(() => database.close());

/** Starts an import and waits for it to finish. */
async function importStaff(): Promise<SubmissionView> {
  const { submissionId } = await service.importStaff(L, 'organizer');
  await service.idle();
  return service.get(L, submissionId);
}

const history = () =>
  database.sqlite
    .prepare('select tournament_id, player_id, role, source from staff_history order by tournament_id, player_id')
    .all();

describe('importing staff from play-tools (ADR-0007 decision 5)', () => {
  it('records the staff of every tournament the account organizes, as a staff_import job', async () => {
    upstream.add(tournament('t-1', { organizer: ORGANIZER }), staffer('100', 'judge', 'Ash K'), playing('500'));
    upstream.add(tournament('t-2', { organizer: ORGANIZER }), staffer('200', 'scorekeeper', 'Brock S'));

    const view = await importStaff();

    expect(view).toMatchObject({
      kind: 'staff_import',
      date: '2026-10-13',
      playSessionId: '',
      playSessionLabel: 'Staff import',
      startedBy: 'organizer',
      status: 'succeeded',
      error: null,
    });
    expect(history()).toEqual([
      { tournament_id: 't-1', player_id: '100', role: 'judge', source: 'upstream' },
      { tournament_id: 't-2', player_id: '200', role: 'scorekeeper', source: 'upstream' },
    ]);
  });

  it('has one item per staffer however many tournaments they staffed, and none for the organizer or players', async () => {
    upstream.add(tournament('t-1'), staffer('100', 'judge'), staffer('200', 'scorekeeper'), playing('500'), playing('501'));
    upstream.add(tournament('t-2'), staffer('100', 'judge'), playing('500'));
    upstream.add(tournament('t-3'), playing('502'));

    const view = await importStaff();

    expect(view.items.map((i) => [i.playerId, i.origin]).sort()).toEqual([
      ['100', 'upstream'],
      ['200', 'upstream'],
    ]);
    expect(history()).toEqual([
      { tournament_id: 't-1', player_id: '100', role: 'judge', source: 'upstream' },
      { tournament_id: 't-1', player_id: '200', role: 'scorekeeper', source: 'upstream' },
      { tournament_id: 't-2', player_id: '100', role: 'judge', source: 'upstream' },
    ]);
    expect(view.staffImport).toEqual({
      tournamentsTotal: 3,
      tournamentsRead: 3,
      tournamentsFailed: 0,
      staffersFound: 2,
      newPlayers: [
        { playerId: '100', name: '' },
        { playerId: '200', name: '' },
      ],
    });
  });

  it('tells staffers the league already knew (found) from players it adds (new_player), across tournaments', async () => {
    roster.ensurePlayers(L, [{ playerId: id('100'), name: 'Ash K.' }]);
    upstream.add(tournament('t-1'), staffer('100', 'judge', 'Ashley Ketchum'), staffer('200', 'judge', 'Brock Stone'));
    upstream.add(tournament('t-2'), staffer('200', 'headjudge', 'Brock Stone'), staffer('300', 'translator', 'Cilan Dent'));

    const view = await importStaff();

    expect(Object.fromEntries(view.items.map((i) => [i.playerId, i.outcome]))).toEqual({
      '100': 'found',
      '200': 'new_player',
      '300': 'new_player',
    });
    expect(view.staffImport?.newPlayers).toEqual([
      { playerId: '200', name: 'Brock Stone' },
      { playerId: '300', name: 'Cilan Dent' },
    ]);
    expect(view.staffImport?.staffersFound).toBe(3);
  });

  it('keeps the local name: a play-tools name only names a player the app could not name (seed-only)', async () => {
    roster.ensurePlayers(L, [{ playerId: id('100'), name: 'Ash K.' }, { playerId: id('200') }]);
    upstream.add(tournament('t-1'), staffer('100', 'judge', 'Ashley Ketchum'), staffer('200', 'judge', 'Brock Stone'));

    await importStaff();
    roster.updatePlayer(L, id('200'), { name: 'Brock S.' });
    const second = await importStaff();

    const names = Object.fromEntries(roster.getPlayers(L, [id('100'), id('200')]).map((p) => [p.playerId, p.displayName]));
    expect(names).toEqual({ '100': 'Ash K.', '200': 'Brock S.' });
    expect(second.items.map((i) => i.outcome)).toEqual(['found', 'found']);
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

describe('starting an import', () => {
  beforeEach(() => upstream.add(tournament('t-1'), staffer('100', 'judge')));

  it('is refused while another job holds the league, and creates nothing', async () => {
    let release!: () => void;
    upstream.gate = new Promise((r) => (release = r));
    await service.importStaff(L, 'organizer');

    const err = await refusal(service.importStaff(L, 'organizer'));

    expect(err).toBeInstanceOf(SubmissionError);
    expect(err.code).toBe('submission_running');
    expect(jobs().n).toBe(1);
    release();
    await service.idle();
  });

  it('holds the league while it runs: a staff job is refused, and the lease frees when it ends', async () => {
    let release!: () => void;
    upstream.gate = new Promise((r) => (release = r));
    await service.importStaff(L, 'organizer');

    expect((await refusal(service.applyStaff(L, '2026-10-14' as SessionDate, { tournamentId: 't-1', startedBy: 'o' }))).code).toBe(
      'submission_running',
    );

    release();
    await service.idle();
    expect(await service.importStaff(L, 'organizer')).toEqual({ submissionId: expect.any(Number) });
    await service.idle();
  });

  it.each([
    ['not_connected', { status: 'not_connected' as const, reason: null, connectedAt: null, lastRefreshedAt: null, league: null }],
    ['needs_reconnect', { status: 'needs_reconnect' as const, reason: 'Reconnect.', connectedAt: null, lastRefreshedAt: null, league: null }],
  ])('is refused with %s when the Pokémon account is not usable, before any call', async (code, view) => {
    connection = view as ConnectionView;

    const err = await refusal(service.importStaff(L, 'organizer'));

    expect(err).toBeInstanceOf(PokemonUpstreamError);
    expect(err.code).toBe(code);
    expect(upstream.calls).toEqual([]);
    expect(jobs().n).toBe(0);
  });

  it('is refused with league_not_selected when no league is chosen', async () => {
    connection = { ...connection, league: null };

    const err = await refusal(service.importStaff(L, 'organizer'));

    expect(err).toBeInstanceOf(SubmissionError);
    expect(err.code).toBe('league_not_selected');
    expect(jobs().n).toBe(0);
  });

  it('is refused with shutting_down once the app is stopping', async () => {
    await service.shutdown();

    expect((await refusal(service.importStaff(L, 'organizer'))).code).toBe('shutting_down');
    expect(jobs().n).toBe(0);
  });
});

const down = () => new PokemonUpstreamError('unavailable', 'play-tools answered 503.', { status: 503 });
const events = (submissionId: number) => service.events(L, submissionId).map((e) => e.type);

describe('reading tournaments', () => {
  beforeEach(() => {
    upstream.add(tournament('t-1'), staffer('100', 'judge'));
    upstream.add(tournament('t-2'), staffer('200', 'judge'));
    upstream.add(tournament('t-3'), staffer('300', 'judge'));
  });

  it('lists once with no range, then reads each tournament once, one call at a time and never sleeping between them', async () => {
    const view = await importStaff();

    expect(upstream.calls).toEqual(['list', 'read t-1', 'read t-2', 'read t-3']);
    expect(upstream.maxInFlight).toBe(1);
    expect(sleeps).toEqual([]);
    expect(view.status).toBe('succeeded');
  });

  it("includes another league's tournaments and undated ones", async () => {
    upstream.add(tournament('t-other', { groupId: 'another-store' }), staffer('400', 'judge'));
    upstream.add(tournament('t-old', { startsAt: null }), staffer('500', 'scorekeeper'));

    await importStaff();

    expect(history()).toEqual(
      expect.arrayContaining([
        { tournament_id: 't-other', player_id: '400', role: 'judge', source: 'upstream' },
        { tournament_id: 't-old', player_id: '500', role: 'scorekeeper', source: 'upstream' },
      ]),
    );
  });

  it('reads a tournament again after a 503, and succeeds', async () => {
    upstream.onRead = (t, n) => {
      if (t === 't-2' && n === 2) throw down();
    };

    const view = await importStaff();

    expect(upstream.calls).toEqual(['list', 'read t-1', 'read t-2', 'read t-2', 'read t-3']);
    expect(view.status).toBe('succeeded');
    expect(view.staffImport).toMatchObject({ tournamentsRead: 3, tournamentsFailed: 0 });
  });

  it('gives up on a tournament after 3 tries, goes on with the rest, and ends partial', async () => {
    upstream.onRead = (t) => {
      if (t === 't-2') throw down();
    };

    const view = await importStaff();

    expect(upstream.calls.filter((c) => c === 'read t-2')).toHaveLength(3);
    expect(events(view.id).filter((e) => e === 'tournament_failed')).toHaveLength(1);
    expect(history().map((h) => (h as { player_id: string }).player_id)).toEqual(['100', '300']);
    expect(view.status).toBe('partial');
    expect(view.staffImport).toMatchObject({ tournamentsTotal: 3, tournamentsRead: 2, tournamentsFailed: 1 });
  });

  it('waits out a 429 for as long as play-tools asks, then reads that tournament again', async () => {
    upstream.onRead = (t, n) => {
      if (t === 't-1' && n === 1) throw new PokemonUpstreamError('rate_limited', 'Slow down.', { status: 429, retryAfterMs: 7_000 });
    };

    const view = await importStaff();

    expect(sleeps).toEqual([7_000]);
    expect(upstream.calls).toEqual(['list', 'read t-1', 'read t-1', 'read t-2', 'read t-3']);
    expect(view.status).toBe('succeeded');
  });

  it.each([
    ['not_found', new PokemonUpstreamError('not_found', 'Gone.', { status: 404 })],
    ['unexpected_shape', new PokemonUpstreamError('unexpected_shape', 'Odd body.')],
  ])('marks a tournament failed on %s without reading it again, and goes on', async (_, error) => {
    upstream.onRead = (t) => {
      if (t === 't-2') throw error;
    };

    const view = await importStaff();

    expect(upstream.calls.filter((c) => c === 'read t-2')).toHaveLength(1);
    expect(view.status).toBe('partial');
    expect(view.staffImport).toMatchObject({ tournamentsRead: 2, tournamentsFailed: 1 });
  });

  it('ends failed when no tournament could be read', async () => {
    upstream.onRead = () => {
      throw new PokemonUpstreamError('not_found', 'Gone.', { status: 404 });
    };

    expect((await importStaff()).status).toBe('failed');
  });

  it.each([
    ['forbidden', new PokemonUpstreamError('forbidden', 'play-tools refused the request (403).', { status: 403 })],
    ['needs_reconnect', new PokemonUpstreamError('needs_reconnect', 'Reconnect the Pokémon account in Settings.')],
  ])('stops failed with %s, sends nothing more, and keeps what it recorded', async (code, error) => {
    upstream.onRead = (t) => {
      if (t === 't-2') throw error;
    };

    const view = await importStaff();

    expect(upstream.calls).toEqual(['list', 'read t-1', 'read t-2']);
    expect(view).toMatchObject({ status: 'failed', error: code });
    expect(history().map((h) => (h as { player_id: string }).player_id)).toEqual(['100']);
    expect(events(view.id).at(-1)).toBe('finished');
  });

  it('ends failed with unavailable when the tournaments cannot be listed after 3 tries', async () => {
    upstream.onList = () => {
      throw down();
    };

    const view = await importStaff();

    expect(upstream.calls).toEqual(['list', 'list', 'list']);
    expect(view).toMatchObject({ status: 'failed', error: 'unavailable' });
    expect(history()).toEqual([]);
  });
});

describe('an account that organizes no tournaments', () => {
  it('succeeds with nothing to count', async () => {
    const view = await importStaff();

    expect(view.status).toBe('succeeded');
    expect(view.staffImport).toEqual({ tournamentsTotal: 0, tournamentsRead: 0, tournamentsFailed: 0, staffersFound: 0, newPlayers: [] });
  });
});

describe('progress and history', () => {
  beforeEach(() => {
    upstream.add(tournament('t-1'), staffer('100', 'judge'));
    upstream.add(tournament('t-2'), staffer('200', 'judge'));
  });

  it('streams planned, one tournament_read per tournament, then finished with the status', async () => {
    const seen: { type: string; done: number; total: number }[] = [];
    const { submissionId } = await service.importStaff(L, 'organizer');
    service.subscribe(submissionId, (e) => seen.push({ type: e.type, done: e.done, total: e.total }));
    await service.idle();

    expect(seen).toEqual([
      { type: 'planned', done: 0, total: 2 },
      { type: 'tournament_read', done: 1, total: 2 },
      { type: 'tournament_read', done: 2, total: 2 },
      { type: 'finished', done: 2, total: 2 },
    ]);
    expect(service.events(L, submissionId).at(-1)?.message).toMatch(/succeeded/);
  });

  it('is listed as a staff_import that cannot be undone', async () => {
    const view = await importStaff();

    expect(service.list(L)).toEqual([expect.objectContaining({ id: view.id, kind: 'staff_import', playSessionLabel: 'Staff import' })]);
    expect(view).toMatchObject({ undoable: false, undoBlockedReason: 'not_undoable' });
    expect((await refusal(service.undo(L, view.id, 'organizer'))).code).toBe('not_undoable');
  });

  it('logs ids and counts, never a name', async () => {
    upstream.add(tournament('t-3'), staffer('300', 'judge', 'Brock Stone'));
    upstream.onRead = (t) => {
      if (t === 't-3') throw new PokemonUpstreamError('not_found', 'Gone.', { status: 404 });
    };
    roster.ensurePlayers(L, [{ playerId: id('100'), name: 'Ash K.' }]);
    upstream.participants.set('t-1', [staffer('100', 'judge', 'Ashley Ketchum')]);

    await importStaff();

    const logged = JSON.stringify(logs);
    expect(logged).toContain('t-3');
    expect(logged).not.toMatch(/Ash|Brock|Olive/);
  });
});

describe('retry, crash and shutdown', () => {
  beforeEach(() => {
    upstream.add(tournament('t-1'), staffer('100', 'judge'));
    upstream.add(tournament('t-2'), staffer('200', 'judge'));
  });

  it('retries a partial import as a new attempt that reads everything again and duplicates nothing', async () => {
    upstream.onRead = (t) => {
      if (t === 't-2') throw down();
    };
    const first = await importStaff();
    upstream.onRead = undefined;
    upstream.calls = [];

    const { submissionId } = await service.retry(L, first.id, 'organizer');
    await service.idle();
    const second = service.get(L, submissionId);

    expect(first.status).toBe('partial');
    expect(second).toMatchObject({ kind: 'staff_import', retryOf: first.id, status: 'succeeded' });
    expect(upstream.calls).toEqual(['list', 'read t-1', 'read t-2']);
    expect(history()).toHaveLength(2);
    expect(Object.fromEntries(second.items.map((i) => [i.playerId, i.outcome]))).toEqual({ '100': 'found', '200': 'new_player' });
  });

  it('a running import found on boot becomes interrupted, and its lease is freed', async () => {
    let release!: () => void;
    upstream.gate = new Promise((r) => (release = r));
    const { submissionId } = await service.importStaff(L, 'organizer');

    // A new process: the old job's promise is abandoned.
    const rebooted = build();
    expect(rebooted.recoverInterrupted()).toBe(1);

    expect(rebooted.get(L, submissionId).status).toBe('interrupted');
    expect(database.sqlite.prepare('select count(*) n from submission_lock').get()).toEqual({ n: 0 });
    release();
    await service.idle();
  });

  it('stops while waiting out a 429 on shutdown: no further call, interrupted, what it read stays', async () => {
    upstream.onRead = (t) => {
      if (t === 't-2') throw new PokemonUpstreamError('rate_limited', 'Slow down.', { status: 429, retryAfterMs: 30_000 });
    };
    onSleep = async (signal) => {
      void service.shutdown();
      expect(signal.aborted).toBe(true);
      throw signal.reason;
    };

    const view = await importStaff();

    expect(upstream.calls).toEqual(['list', 'read t-1', 'read t-2']);
    expect(view.status).toBe('interrupted');
    expect(history().map((h) => (h as { player_id: string }).player_id)).toEqual(['100']);
    expect(service.events(L, view.id).at(-1)).toMatchObject({ type: 'finished', done: 1, total: 2 });
  });
});
