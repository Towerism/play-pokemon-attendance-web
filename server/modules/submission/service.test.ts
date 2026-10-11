import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { silentLogger } from '../../logging/types';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import type { ConnectionView } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { AttendanceRecord, BulkResult, PlaySession } from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { type SessionsService, createSessionsService } from '../sessions/service';
import { SubmissionError } from './errors';
import { createPlaySessionResolver } from './resolve';
import { type SubmissionDeps, type SubmissionService, type SubmissionView, createSubmissionService } from './service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TUESDAY = '2026-10-13' as SessionDate;
const PS = 'ps-tuesday';
const GROUP = 'group-1';
const DELAY = 15_000;
const UNDO_DELAY = 1_000;
const id = (s: string) => s as PlayerId;

/**
 * play-tools as a fake, with the semantics spike S4 recorded: `_bulk` is
 * all-or-nothing, a participant already holding a record (any role) is
 * refused, and records list every role.
 */
class FakePlayTools {
  records: AttendanceRecord[] = [];
  bulkCalls: PlayerId[][] = [];
  listCalls = 0;
  /** Runs before each bulk call; may throw or return a result to short-circuit. */
  onBulk: ((ids: readonly PlayerId[], call: number) => unknown) | undefined;
  /** Runs before each attendance listing. */
  onList: ((call: number) => void) | undefined;
  session: PlaySession = {
    id: PS,
    type: 'open_play',
    products: ['tcg'],
    status: 'active',
    startsAt: new Date('2026-10-13T23:00:00Z'),
    endsAt: null,
    editableUntil: new Date('2026-10-20T23:00:00Z'),
  };
  private serial = 0;

  has(playerId: string, opts: { asStaff?: boolean; name?: string } = {}): void {
    this.records.push({ recordId: `pre-${playerId}`, playerId: id(playerId), isPlayer: !opts.asStaff, name: opts.name ?? '' });
  }

  ids(): string[] {
    return this.records.map((r) => r.playerId);
  }

  async listPlaySessions(): Promise<PlaySession[]> {
    return [this.session];
  }

  /** While set, attendance listings wait for it: holds a job mid-run. */
  gate: Promise<void> | undefined;

  async listAttendance(groupId: string, sessionId: string): Promise<AttendanceRecord[]> {
    expect([groupId, sessionId]).toEqual([GROUP, PS]);
    await this.gate;
    this.listCalls += 1;
    this.onList?.(this.listCalls);
    return [...this.records];
  }

  async addAttendanceBulk(groupId: string, sessionId: string, playerIds: readonly PlayerId[]): Promise<BulkResult> {
    expect([groupId, sessionId]).toEqual([GROUP, PS]);
    this.bulkCalls.push([...playerIds]);
    const injected = this.onBulk?.(playerIds, this.bulkCalls.length) as BulkResult | undefined;
    if (injected) return injected;
    const dupes = playerIds.filter((p) => this.records.some((r) => r.playerId === p));
    if (dupes.length > 0) return { status: 'rejected', alreadyPresent: dupes, failed: [] };
    const records = playerIds.map((playerId) => ({ playerId, recordId: `rec-${++this.serial}` }));
    for (const r of records) this.records.push({ ...r, isPlayer: true, name: '' });
    return { status: 'added', records };
  }

  /** Record ids sent a DELETE, with the fake clock's time when each started. */
  removeCalls: { recordId: string; at: number }[] = [];
  /** Runs before each delete; may throw, or return a result to short-circuit. */
  onRemove: ((recordId: string, call: number) => unknown) | undefined;

  async removeAttendance(groupId: string, sessionId: string, recordId: string): Promise<'removed' | 'not_found'> {
    expect([groupId, sessionId]).toEqual([GROUP, PS]);
    this.removeCalls.push({ recordId, at: clock.getTime() });
    const injected = this.onRemove?.(recordId, this.removeCalls.length) as 'removed' | 'not_found' | undefined;
    if (injected) return injected;
    const before = this.records.length;
    this.records = this.records.filter((r) => r.recordId !== recordId);
    return this.records.length < before ? 'removed' : 'not_found';
  }

  recordOf(playerId: string): string {
    return this.records.find((r) => r.playerId === playerId)!.recordId;
  }
}

let database: OpenDatabase;
let roster: RosterService;
let sightings: SightingsService;
let sessions: SessionsService;
let upstream: FakePlayTools;
let connection: ConnectionView;
let clock: Date;
let sleeps: number[];
/** Runs inside every pacing sleep (e.g. to shut down mid-wait). */
let onSleep: ((signal: AbortSignal) => Promise<void> | void) | undefined;
let service: SubmissionService;

function build(
  over: {
    batchSize?: number;
    defaults?: boolean;
    log?: SubmissionDeps['log'] | null;
    undoDelayMs?: number;
    sessions?: SessionsService;
    sightings?: SightingsService;
  } = {},
): SubmissionService {
  const resolver = createPlaySessionResolver({
    connections: { getStatus: () => connection },
    gateway: () => upstream,
    timeZone: 'America/Chicago',
    now: () => clock,
  });
  return createSubmissionService({
    db: database.db,
    sessions: over.sessions ?? sessions,
    roster,
    sightings: over.sightings ?? sightings,
    connections: { getStatus: () => connection },
    gateway: () => upstream,
    resolver,
    now: () => clock,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      await onSleep?.(signal);
      clock = new Date(clock.getTime() + ms);
    },
    ...(over.defaults ? {} : { batchSize: over.batchSize ?? 50, batchDelayMs: DELAY, undoDelayMs: over.undoDelayMs ?? UNDO_DELAY }),
    ...(over.log === null ? {} : { log: over.log ?? silentLogger }),
  });
}

/** A fresh database, services and fake play-tools. */
function setUp(): void {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  roster = createRosterService({ db: database.db });
  sightings = createSightingsService({ db: database.db });
  sessions = createSessionsService({ db: database.db, roster, sightings });
  upstream = new FakePlayTools();
  clock = new Date('2026-10-14T02:00:00Z');
  connection = {
    status: 'connected',
    reason: null,
    connectedAt: clock,
    lastRefreshedAt: clock,
    league: { id: GROUP, name: 'Card Shop', displayId: 'L5012', canSubmit: true },
  };
  sleeps = [];
  onSleep = undefined;
  service = build();
}
beforeEach(setUp);
afterEach(() => database.close());

const regulars = (...ids: string[]) => ids.forEach((p) => roster.addRegular(L, { playerId: id(p), name: `Regular ${p}` }));
const sessionPlayers = (...ids: string[]) => ids.forEach((p) => sessions.addPlayer(L, TUESDAY, { playerId: id(p), name: `Player ${p}` }));

/** Starts a submission and waits for the job to finish. */
async function submit(): Promise<SubmissionView> {
  const { submissionId } = await service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'organizer' });
  await service.idle();
  return service.get(L, submissionId);
}

const outcomes = (view: SubmissionView) => Object.fromEntries(view.items.map((i) => [i.playerId, i.outcome]));

describe('a submission (ADR-0004 plan → execute → reconcile)', () => {
  it('adds regulars and session players to an empty session and records what it did', async () => {
    regulars('9');
    sessionPlayers('1', '2');

    const view = await submit();

    expect(upstream.ids().sort()).toEqual(['1', '2', '9']);
    expect(view).toMatchObject({
      date: TUESDAY,
      playSessionId: PS,
      playSessionLabel: 'Open play · TCG · Tue 6:00 PM',
      startedBy: 'organizer',
      status: 'succeeded',
      error: null,
      counts: { added: 3, alreadyPresent: 0, failed: 0, skipped: 0, unrequested: 0 },
    });
    expect(view.items.find((i) => i.playerId === '9')).toEqual({
      playerId: '9',
      displayName: 'Regular 9',
      origin: 'regular',
      outcome: 'added',
      error: null,
      recordId: expect.stringMatching(/^rec-/),
      asStaff: false,
      removedBy: null,
    });
    expect(view.finishedAt).toEqual(clock);
  });

  it('sends only who upstream is missing; the rest are already_present', async () => {
    regulars('9');
    sessionPlayers('1', '2');
    upstream.has('2');

    const view = await submit();

    expect(upstream.bulkCalls).toEqual([['1', '9']]);
    expect(outcomes(view)).toEqual({ '1': 'added', '2': 'already_present', '9': 'added' });
    expect(view.status).toBe('succeeded');
  });

  it('is safe to submit twice: the second run sends nothing', async () => {
    regulars('9');
    sessionPlayers('1');
    await submit();
    upstream.bulkCalls = [];

    const again = await submit();

    expect(upstream.bulkCalls).toEqual([]);
    expect(outcomes(again)).toEqual({ '1': 'already_present', '9': 'already_present' });
    expect(again.status).toBe('succeeded');
  });

  it("treats a regular who holds the session's organizer record as present, and never sends them (design change 6)", async () => {
    regulars('9');
    upstream.has('9', { asStaff: true });

    const view = await submit();

    expect(upstream.bulkCalls).toEqual([]);
    expect(view.items).toEqual([expect.objectContaining({ playerId: '9', outcome: 'already_present', asStaff: true })]);
  });

  it('by default sends 20 players per batch, 10 s apart (smaller batches rarely hit the 502 gateway timeout)', async () => {
    service = build({ defaults: true });
    sessionPlayers(...Array.from({ length: 45 }, (_, i) => String(i + 1)));

    await submit();

    expect(upstream.bulkCalls.map((b) => b.length)).toEqual([20, 20, 5]);
    expect(sleeps).toEqual([10_000, 10_000]);
  });

  it('sends session players before regulars, in batches of at most the batch size, spaced by the batch delay', async () => {
    service = build({ batchSize: 2 });
    regulars('7', '8', '9');
    sessionPlayers('1', '2');

    await submit();

    expect(upstream.bulkCalls).toEqual([['1', '2'], ['7', '8'], ['9']]);
    expect(sleeps).toEqual([DELAY, DELAY]);
  });

  it('keeps players it did not ask for, reports them, learns their names and records an upstream_existing sighting', async () => {
    sessionPlayers('1');
    upstream.has('5', { name: 'Walk In' });
    upstream.has('6', { asStaff: true, name: 'Judge Person' });

    const view = await submit();

    expect(upstream.ids()).toContain('5');
    expect(view.items.find((i) => i.playerId === '5')).toMatchObject({ origin: 'upstream', outcome: 'unrequested', displayName: 'Walk In' });
    expect(view.items.find((i) => i.playerId === '6')).toBeUndefined();
    expect(view.counts.unrequested).toBe(1);
    expect(sightings.on(L, TUESDAY)).toContainEqual({ playerId: '5', kind: 'upstream_existing' });
    expect(sightings.on(L, TUESDAY).map((s) => s.playerId)).not.toContain('6');
  });

  it('records no upstream_existing sighting for a player one of our own submissions added', async () => {
    regulars('9');
    sessionPlayers('1');
    await submit();
    sessions.removePlayer(L, TUESDAY, id('1'));

    const view = await submit();

    expect(view.items.find((i) => i.playerId === '1')).toMatchObject({ outcome: 'unrequested' });
    expect(sightings.on(L, TUESDAY)).toEqual([]);
  });

  describe('when play-tools rejects a batch (S4: all-or-nothing)', () => {
    it('resends the rest once without a player someone else recorded meanwhile, who is already_present', async () => {
      sessionPlayers('1', '2', '3');
      upstream.onBulk = (_ids, call) => {
        if (call === 1) upstream.has('2'); // recorded in play-tools by hand between plan and execute
      };

      const view = await submit();

      expect(upstream.bulkCalls).toEqual([['1', '2', '3'], ['1', '3']]);
      expect(sleeps).toEqual([DELAY]);
      expect(outcomes(view)).toEqual({ '1': 'added', '2': 'already_present', '3': 'added' });
      expect(view.status).toBe('succeeded');
    });

    it('fails a player play-tools refuses, with its reason, and still adds the others', async () => {
      sessionPlayers('1', '2', '3');
      upstream.onBulk = (ids) =>
        ids.includes(id('2')) ? { status: 'rejected', alreadyPresent: [], failed: [{ playerId: id('2'), error: 'op.player.not_found' }] } : undefined;

      const view = await submit();

      expect(upstream.bulkCalls).toEqual([['1', '2', '3'], ['1', '3']]);
      expect(view.items.find((i) => i.playerId === '2')).toMatchObject({ outcome: 'failed', error: 'op.player.not_found' });
      expect(outcomes(view)).toMatchObject({ '1': 'added', '3': 'added' });
      expect(view.status).toBe('partial');
    });

    it('resends only once: a second rejection fails whoever is left', async () => {
      sessionPlayers('1', '2', '3');
      upstream.onBulk = (_ids, call) => ({
        status: 'rejected',
        alreadyPresent: [],
        failed: [{ playerId: id(call === 1 ? '1' : '3'), error: 'op.x' }],
      });

      const view = await submit();

      expect(upstream.bulkCalls).toHaveLength(2);
      expect(view.items.find((i) => i.playerId === '2')).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/batch/) });
      expect(view.status).toBe('failed');
    });
  });

  describe('when play-tools is down or throttling', () => {
    it('re-reads before retrying, so a 5xx that did record the players is not resent', async () => {
      sessionPlayers('1', '2');
      upstream.onBulk = (ids, call) => {
        if (call === 1) {
          ids.forEach((p) => upstream.has(p));
          throw new PokemonUpstreamError('unavailable', 'Adding attendance: Pokémon answered 502.');
        }
      };

      const view = await submit();

      expect(upstream.bulkCalls).toHaveLength(1);
      expect(outcomes(view)).toEqual({ '1': 'added', '2': 'added' });
    });

    describe('a 502 gateway timeout on a large batch (field report: the players appear about a minute later)', () => {
      /** The batch lands upstream only after `afterLists` more attendance reads. */
      function landsLate(afterLists: number) {
        upstream.onBulk = (ids, call) => {
          if (call !== 1) return undefined;
          const landAt = upstream.listCalls + afterLists;
          const previous = upstream.onList;
          upstream.onList = (n) => {
            previous?.(n);
            if (n === landAt) ids.forEach((p) => upstream.has(p));
          };
          throw new PokemonUpstreamError('unavailable', 'Adding attendance: Pokémon answered 502.');
        };
      }

      it('keeps re-reading until the players show up, and never resends them', async () => {
        sessionPlayers('1', '2', '3');
        landsLate(4); // about a minute at 15 s per read

        const view = await submit();

        expect(upstream.bulkCalls).toHaveLength(1);
        expect(outcomes(view)).toEqual({ '1': 'added', '2': 'added', '3': 'added' });
        expect(view.status).toBe('succeeded');
        expect(sleeps.every((ms) => ms === DELAY)).toBe(true);
      });

      it('resends only who is still missing once the settle window has passed', async () => {
        sessionPlayers('1', '2');
        upstream.onBulk = (ids, call) => {
          if (call === 1) throw new PokemonUpstreamError('unavailable', 'Adding attendance: Pokémon answered 502.');
          return undefined;
        };

        const view = await submit();

        expect(upstream.bulkCalls).toEqual([['1', '2'], ['1', '2']]);
        expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3 * 60_000);
        expect(view.status).toBe('succeeded');
      });

      it('counts players of its own timed-out batch as added when a resend is refused as duplicate', async () => {
        sessionPlayers('1', '2');
        landsLate(1_000); // never seen within the window…
        const late = upstream.onBulk!;
        upstream.onBulk = (ids, call) => {
          if (call === 2) ids.forEach((p) => upstream.has(p)); // …but it lands just before the resend
          return late(ids, call);
        };

        const view = await submit();

        expect(outcomes(view)).toEqual({ '1': 'added', '2': 'added' });
        expect(view.counts.added).toBe(2);
      });
    });

    it('waits as long as play-tools asks after a 429', async () => {
      sessionPlayers('1');
      upstream.onBulk = (_ids, call) => {
        if (call === 1) throw new PokemonUpstreamError('rate_limited', 'slow down', { status: 429, retryAfterMs: 60_000 });
      };

      await submit();

      expect(sleeps).toEqual([60_000]);
    });

    it('gives up on a batch after three attempts, fails its players, and goes on with the next batch', async () => {
      service = build({ batchSize: 1 });
      sessionPlayers('1', '2');
      upstream.onBulk = (ids) => {
        if (ids.includes(id('1'))) throw new PokemonUpstreamError('unavailable', 'Adding attendance: Pokémon answered 503.');
      };

      const view = await submit();

      expect(upstream.bulkCalls).toEqual([['1'], ['1'], ['1'], ['2']]);
      expect(view.items.find((i) => i.playerId === '1')).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/503/) });
      expect(view.status).toBe('partial');
    });
  });

  it('trusts the re-read over the bulk response: a reported add missing upstream is failed', async () => {
    sessionPlayers('1', '2');
    upstream.onBulk = (ids) => ({ status: 'added', records: ids.map((playerId) => ({ playerId, recordId: `ghost-${playerId}` })) });

    const view = await submit();

    expect(outcomes(view)).toEqual({ '1': 'failed', '2': 'failed' });
    expect(view.items[0]!.error).toMatch(/not recorded/i);
    expect(view.status).toBe('failed');
  });

  it('notes the resolved play session and the outcome on the draft', async () => {
    sessionPlayers('1');
    await submit();
    expect(sessions.getSession(L, TUESDAY)).toMatchObject({ playSessionId: PS, status: 'submitted' });
  });

  it('stops when Pokémon refuses the login mid-run: failed with the reason, unsent players skipped', async () => {
    service = build({ batchSize: 1 });
    sessionPlayers('1', '2');
    upstream.onBulk = (_ids, call) => {
      if (call === 2) throw new PokemonUpstreamError('needs_reconnect', 'Pokémon no longer accepts the saved login.');
    };

    const view = await submit();

    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/no longer accepts/);
    expect(outcomes(view)).toEqual({ '1': 'added', '2': 'skipped' });
    expect(sessions.getSession(L, TUESDAY).status).toBe('failed');
  });
});

describe('job logging', () => {
  const spyLog = () => ({ info: vi.fn(), warn: vi.fn() });

  it('logs when a job starts and how it ended, tagged with its id', async () => {
    const log = spyLog();
    service = build({ log });
    sessionPlayers('1');

    const view = await submit();

    expect(log.info.mock.calls).toEqual([
      [`Submission #${view.id} started for ${TUESDAY}`, { submissionId: view.id, date: TUESDAY }],
      [`Submission #${view.id} succeeded`, { submissionId: view.id, status: 'succeeded' }],
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns with the reason when a job fails, without a [submission] prefix', async () => {
    const log = spyLog();
    service = build({ batchSize: 1, log });
    sessionPlayers('1', '2');
    upstream.onBulk = (_ids, call) => {
      if (call === 2) throw new PokemonUpstreamError('needs_reconnect', 'Pokémon no longer accepts the saved login.');
    };

    const view = await submit();

    expect(log.warn).toHaveBeenCalledWith(`Submission #${view.id} failed: Pokémon no longer accepts the saved login.`, {
      submissionId: view.id,
    });
    expect(log.info).toHaveBeenLastCalledWith(`Submission #${view.id} failed`, { submissionId: view.id, status: 'failed' });
  });

  it('stays silent without a logger, rather than writing to the console', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    service = build({ batchSize: 1, log: null });
    sessionPlayers('1', '2');
    upstream.onBulk = (_ids, call) => {
      if (call === 2) throw new PokemonUpstreamError('needs_reconnect', 'gone');
    };

    await submit();

    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

async function refusal(promise: Promise<unknown>): Promise<SubmissionError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SubmissionError);
  return err as SubmissionError;
}

const countSubmissions = () => (database.sqlite.prepare('select count(*) n from submission').get() as { n: number }).n;

describe('starting a submission', () => {
  it('is refused once the attendance edit window has closed, before anything is created (design change 2)', async () => {
    sessionPlayers('1');
    clock = new Date('2026-10-21T00:00:00Z');
    expect((await refusal(service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' }))).code).toBe('edit_window_closed');
    expect(countSubmissions()).toBe(0);
  });

  it('is refused with nobody to submit', async () => {
    expect((await refusal(service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' }))).code).toBe('nothing_to_submit');
    expect(countSubmissions()).toBe(0);
  });

  it("is refused for a play session that is not that date's", async () => {
    sessionPlayers('1');
    expect((await refusal(service.start(L, TUESDAY, { playSessionId: 'elsewhere', startedBy: 'o' }))).code).toBe('unknown_play_session');
  });

  describe('the per-league lock', () => {
    let release: () => void;
    beforeEach(() => {
      sessionPlayers('1');
      upstream.gate = new Promise((r) => (release = r));
    });

    it('refuses a second submission while one runs, and frees up when it finishes', async () => {
      await service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' });
      expect((await refusal(service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' }))).code).toBe('submission_running');

      release();
      await service.idle();
      expect(await service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' })).toEqual({ submissionId: expect.any(Number) });
      await service.idle();
    });

    it('frees up when a job fails', async () => {
      upstream.gate = undefined;
      upstream.onList = () => {
        throw new PokemonUpstreamError('forbidden', 'nope');
      };
      await submit();
      upstream.onList = undefined;
      expect((await submit()).status).toBe('succeeded');
    });

    it('ignores a lease left behind by a crashed process once it has expired', async () => {
      release();
      database.sqlite.prepare("insert into submission_lock (league_id, submission_id, expires_at) values ('default', 999, ?)").run(clock.getTime() - 1);
      expect((await submit()).status).toBe('succeeded');
    });
  });
});

describe('progress events', () => {
  it('are persisted in order, ending with the outcome, with players sent out of players to add', async () => {
    service = build({ batchSize: 2 });
    regulars('9');
    sessionPlayers('1', '2');
    upstream.has('9');

    const { id: submissionId } = await submit();

    const events = service.events(L, submissionId);
    expect(events.map((e) => [e.type, e.done, e.total])).toEqual([
      ['planned', 0, 2],
      ['batch_sent', 2, 2],
      ['reconciled', 2, 2],
      ['finished', 2, 2],
    ]);
    expect(events[0]!.message).toMatch(/2 to add, 1 already in play-tools/);
    expect(events.at(-1)!.message).toMatch(/succeeded/i);
    expect(service.events(L, submissionId, events[1]!.id).map((e) => e.type)).toEqual(['reconciled', 'finished']);
  });

  it('are pushed live to subscribers', async () => {
    sessionPlayers('1');
    upstream.gate = Promise.resolve();
    const seen: string[] = [];
    const { submissionId } = await service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' });
    const unsubscribe = service.subscribe(submissionId, (e) => seen.push(e.type));
    await service.idle();
    unsubscribe();
    expect(seen).toEqual(['planned', 'batch_sent', 'reconciled', 'finished']);
  });

  it('are not_found for another league', async () => {
    sessionPlayers('1');
    const { id: submissionId } = await submit();
    expect(() => service.events('other', submissionId)).toThrow(SubmissionError);
  });
});

describe('history', () => {
  it('lists submissions newest first, optionally for one date, without items', async () => {
    sessionPlayers('1');
    const first = await submit();
    clock = new Date(clock.getTime() + 60_000);
    const second = await submit();

    const list = service.list(L);
    expect(list.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(list[0]).toEqual({
      id: second.id,
      date: TUESDAY,
      playSessionLabel: 'Open play · TCG · Tue 6:00 PM',
      startedBy: 'organizer',
      startedAt: clock,
      finishedAt: clock,
      status: 'succeeded',
      retryOf: null,
      kind: 'submit',
      undoOf: null,
      undoable: false,
      undoBlockedReason: 'nothing_to_undo',
      counts: { added: 0, alreadyPresent: 1, failed: 0, skipped: 0, unrequested: 0 },
    });
    expect(service.list(L, { date: '2026-10-20' as SessionDate })).toEqual([]);
    expect(service.list('other')).toEqual([]);
  });

  it('counts, per player, the session dates they were added to or already present on (audit, §5)', async () => {
    regulars('9');
    sessionPlayers('1', '2');
    upstream.has('5'); // nobody here asked for 5: unrequested
    upstream.onBulk = (ids) =>
      ids.includes(id('2')) ? { status: 'rejected', alreadyPresent: [], failed: [{ playerId: id('2'), error: 'op.x' }] } : undefined;
    await submit();

    expect(service.timesSubmitted(L)).toEqual(new Map([['1', 1], ['9', 1]]));

    upstream.onBulk = undefined;
    await submit(); // a second attempt for the same date: 2 added, 1 and 9 already present

    expect(service.timesSubmitted(L)).toEqual(new Map([['1', 1], ['2', 1], ['9', 1]]));
    expect(service.timesSubmitted('other')).toEqual(new Map());
  });

  it('get is not_found for an unknown id or another league', async () => {
    sessionPlayers('1');
    const { id: submissionId } = await submit();
    expect(() => service.get(L, 999)).toThrow(SubmissionError);
    expect(() => service.get('other', submissionId)).toThrow(SubmissionError);
  });
});

describe('retry and resume', () => {
  it('re-plans from upstream as a new attempt and sends only what is still missing', async () => {
    sessionPlayers('1', '2');
    upstream.onBulk = (ids) =>
      ids.includes(id('2')) ? { status: 'rejected', alreadyPresent: [], failed: [{ playerId: id('2'), error: 'op.x' }] } : undefined;
    const first = await submit();
    expect(first.status).toBe('partial');
    upstream.onBulk = undefined;
    upstream.bulkCalls = [];

    const { submissionId } = await service.retry(L, first.id, 'organizer');
    await service.idle();

    const retried = service.get(L, submissionId);
    expect(submissionId).not.toBe(first.id);
    expect(retried).toMatchObject({ retryOf: first.id, playSessionId: PS, status: 'succeeded' });
    expect(upstream.bulkCalls).toEqual([['2']]);
    expect(service.get(L, first.id).status).toBe('partial');
  });

  it('is refused while the submission is still running', async () => {
    sessionPlayers('1');
    let release!: () => void;
    upstream.gate = new Promise((r) => (release = r));
    const { submissionId } = await service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' });

    expect((await refusal(service.retry(L, submissionId, 'o'))).code).toBe('submission_running');
    release();
    await service.idle();
  });

  it('is not_found for an unknown submission', async () => {
    expect((await refusal(service.retry(L, 42, 'o'))).code).toBe('not_found');
  });

  it("marks a job a crash left running as interrupted on boot, frees the lock, and resumes from upstream's state", async () => {
    sessionPlayers('1', '2');
    upstream.gate = new Promise(() => undefined); // the old process's job never gets further
    const { submissionId } = await service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' });
    // The process dies here; a new one boots on the same database.
    service = build();
    upstream.has('1');

    expect(service.recoverInterrupted()).toBe(1);

    expect(service.get(L, submissionId)).toMatchObject({ status: 'interrupted', finishedAt: clock });
    expect(sessions.getSession(L, TUESDAY).status).toBe('failed');
    upstream.gate = undefined;
    const resumed = await service.retry(L, submissionId, 'o');
    await service.idle();
    expect(service.get(L, resumed.submissionId).status).toBe('succeeded');
    expect(upstream.bulkCalls).toEqual([['2']]);
  });
});

describe('shutdown', () => {
  it('stops before the next batch, marks the job interrupted and frees the lock', async () => {
    service = build({ batchSize: 1 });
    sessionPlayers('1', '2', '3');
    onSleep = async (signal) => {
      void service.shutdown();
      expect(signal.aborted).toBe(true);
      throw signal.reason;
    };

    const view = await submit();

    expect(upstream.bulkCalls).toEqual([['1']]);
    expect(view.status).toBe('interrupted');
    expect(outcomes(view)).toEqual({ '1': 'added', '2': 'skipped', '3': 'skipped' });
    expect(database.sqlite.prepare('select count(*) n from submission_lock').get()).toEqual({ n: 0 });
  });

  it('refuses new submissions once shutting down', async () => {
    sessionPlayers('1');
    await service.shutdown();
    expect((await refusal(service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' }))).code).toBe('shutting_down');
  });
});

/** Undoes a submission and waits for the undo to finish. */
async function undo(submissionId: number): Promise<SubmissionView> {
  const started = await service.undo(L, submissionId, 'organizer');
  await service.idle();
  return service.get(L, started.submissionId);
}

describe('undo: removing the players a submission added', () => {
  it('deletes exactly the records the submission added, nobody else, and records the outcome', async () => {
    regulars('9');
    sessionPlayers('1', '2');
    upstream.has('5'); // added in play-tools directly
    upstream.has('7', { asStaff: true }); // the organizer's record
    const submitted = await submit();
    const ours = [upstream.recordOf('1'), upstream.recordOf('2'), upstream.recordOf('9')];

    const undone = await undo(submitted.id);

    expect(upstream.removeCalls.map((c) => c.recordId).sort()).toEqual(ours.sort());
    expect(upstream.ids().sort()).toEqual(['5', '7']);
    expect(undone).toMatchObject({ kind: 'undo', undoOf: submitted.id, status: 'succeeded', playSessionId: PS, date: TUESDAY });
    expect(outcomes(undone)).toEqual({ '1': 'removed', '2': 'removed', '9': 'removed' });
    expect(undone.id).not.toBe(submitted.id);
  });

  it('sends no delete for a record someone already removed in play-tools; that player is already_removed', async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();
    const [r1, r2] = [upstream.recordOf('1'), upstream.recordOf('2')];
    upstream.records = upstream.records.filter((r) => r.recordId !== r2); // removed by hand

    const undone = await undo(submitted.id);

    expect(upstream.removeCalls.map((c) => c.recordId)).toEqual([r1]);
    expect(outcomes(undone)).toEqual({ '1': 'removed', '2': 'already_removed' });
    expect(undone.status).toBe('succeeded');
  });

  it('counts a delete play-tools answers 404 as already removed, not failed', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    // Someone removes it in play-tools between our re-read and our delete.
    upstream.onRemove = (recordId) => {
      upstream.records = upstream.records.filter((r) => r.recordId !== recordId);
      return 'not_found';
    };

    const undone = await undo(submitted.id);

    expect(outcomes(undone)).toEqual({ '1': 'already_removed' });
    expect(undone.status).toBe('succeeded');
  });

  it('leaves a record alone when play-tools now lists it for a different player', async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();
    const r1 = upstream.recordOf('1');
    upstream.records = upstream.records.map((r) => (r.recordId === r1 ? { ...r, playerId: id('8') } : r));

    const undone = await undo(submitted.id);

    expect(upstream.removeCalls.map((c) => c.recordId)).not.toContain(r1);
    expect(undone.items.find((i) => i.playerId === '1')).toMatchObject({ outcome: 'failed', error: 'record_mismatch' });
    expect(undone.status).toBe('partial');
  });

  it('sends deletes one at a time, at least the undo delay apart', async () => {
    sessionPlayers('1', '2', '3', '4', '5');
    const submitted = await submit();
    sleeps = [];
    let inFlight = 0;
    upstream.onRemove = () => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      inFlight -= 1;
    };

    await undo(submitted.id);

    const starts = upstream.removeCalls.map((c) => c.at);
    expect(starts).toHaveLength(5);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(UNDO_DELAY);
    expect(sleeps).toEqual([UNDO_DELAY, UNDO_DELAY, UNDO_DELAY, UNDO_DELAY]);
  });

  it('by default waits 1 s between deletes', async () => {
    service = build({ defaults: true });
    sessionPlayers('1', '2');
    const submitted = await submit();
    sleeps = [];

    await undo(submitted.id);

    expect(sleeps).toEqual([1_000]);
  });

  it('trusts the final re-read: a record still listed after its delete is failed', async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();
    const r2 = upstream.recordOf('2');
    upstream.onRemove = (recordId) => (recordId === r2 ? 'removed' : undefined); // says 204, keeps it

    const undone = await undo(submitted.id);

    expect(outcomes(undone)).toEqual({ '1': 'removed', '2': 'failed' });
    expect(undone.items.find((i) => i.playerId === '2')!.error).toMatch(/still in play-tools/i);
    expect(undone.status).toBe('partial');
  });

  it('reports progress: planned, one event per delete, reconciled, then finished with the outcome', async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();

    const undone = await undo(submitted.id);

    expect(service.events(L, undone.id).map((e) => [e.type, e.done, e.total])).toEqual([
      ['planned', 0, 2],
      ['record_removed', 1, 2],
      ['record_removed', 2, 2],
      ['reconciled', 2, 2],
      ['finished', 2, 2],
    ]);
    expect(service.events(L, undone.id).at(-1)!.message).toMatch(/succeeded/);
  });
});

describe('starting an undo', () => {
  it('is refused while a submission or another undo runs for the league, before anything is created', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    let release!: () => void;
    upstream.gate = new Promise((r) => (release = r));
    await service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' });
    const before = countSubmissions();

    expect((await refusal(service.undo(L, submitted.id, 'o'))).code).toBe('submission_running');
    expect(countSubmissions()).toBe(before);
    expect(upstream.removeCalls).toEqual([]);
    release();
    await service.idle();
  });

  it('refuses to undo an undo, or a submission that is still running', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    const undone = await undo(submitted.id);
    expect((await refusal(service.undo(L, undone.id, 'o'))).code).toBe('not_undoable');

    sessionPlayers('2'); // the undo took 1 off the date
    let release!: () => void;
    upstream.gate = new Promise((r) => (release = r));
    const { submissionId: running } = await service.start(L, TUESDAY, { playSessionId: PS, startedBy: 'o' });
    expect((await refusal(service.undo(L, running, 'o'))).code).toBe('not_undoable');
    release();
    await service.idle();
  });

  it('has nothing to undo when the submission added nobody, or an earlier undo removed everyone it added', async () => {
    sessionPlayers('1');
    upstream.has('1');
    const nobodyAdded = await submit();
    expect((await refusal(service.undo(L, nobodyAdded.id, 'o'))).code).toBe('nothing_to_undo');

    sessionPlayers('2');
    const added = await submit();
    await undo(added.id);
    expect((await refusal(service.undo(L, added.id, 'o'))).code).toBe('nothing_to_undo');
  });

  it('a second undo, or a retry of a partial one, targets only what the first left behind', async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();
    const [r1, r2] = [upstream.recordOf('1'), upstream.recordOf('2')];
    upstream.onRemove = (recordId) => {
      if (recordId === r2) return 'removed'; // says 204 but keeps it: failed on reconcile
    };
    const first = await undo(submitted.id);
    expect(outcomes(first)).toEqual({ '1': 'removed', '2': 'failed' });
    upstream.onRemove = undefined;
    upstream.removeCalls = [];

    const { submissionId } = await service.retry(L, first.id, 'organizer');
    await service.idle();

    const retried = service.get(L, submissionId);
    expect(retried).toMatchObject({ kind: 'undo', undoOf: submitted.id, retryOf: first.id, status: 'succeeded' });
    expect(outcomes(retried)).toEqual({ '2': 'removed' });
    expect(upstream.removeCalls.map((c) => c.recordId)).toEqual([r2]);
    expect(upstream.removeCalls.map((c) => c.recordId)).not.toContain(r1);
  });

  it('is refused once the attendance edit window has closed, before anything is created', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    clock = new Date('2026-10-21T00:00:00Z');
    const before = countSubmissions();

    expect((await refusal(service.undo(L, submitted.id, 'o'))).code).toBe('edit_window_closed');
    expect(countSubmissions()).toBe(before);
  });

  it('is refused when the play session no longer exists in play-tools', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    upstream.session = { ...upstream.session, id: 'another' };
    clock = new Date(clock.getTime() + 10 * 60_000); // past the resolver's cache

    expect((await refusal(service.undo(L, submitted.id, 'o'))).code).toBe('unknown_play_session');
  });

  it('is not_found for an unknown submission or another league, and refused once shutting down', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    expect((await refusal(service.undo(L, 999, 'o'))).code).toBe('not_found');
    expect((await refusal(service.undo('other', submitted.id, 'o'))).code).toBe('not_found');

    await service.shutdown();
    expect((await refusal(service.undo(L, submitted.id, 'o'))).code).toBe('shutting_down');
  });

  it('targets only added players with a known record id', async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();
    database.sqlite.prepare("update submission_item set record_id = null where player_id = '2'").run();

    const undone = await undo(submitted.id);

    expect(outcomes(undone)).toEqual({ '1': 'removed' });
    expect(upstream.ids()).toEqual(['2']);
  });
});

describe('an undo when play-tools misbehaves', () => {
  it('waits as long as play-tools asks after a 429, then removes the record', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    sleeps = [];
    upstream.onRemove = (_r, call) => {
      if (call === 1) throw new PokemonUpstreamError('rate_limited', 'Slow down.', { status: 429, retryAfterMs: 2_000 });
    };

    const undone = await undo(submitted.id);

    expect(sleeps).toContain(2_000);
    expect(outcomes(undone)).toEqual({ '1': 'removed' });
    expect(service.events(L, undone.id).map((e) => e.type)).toContain('retrying');
  });

  it('re-reads after a 5xx and does not delete again a record that is gone', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    upstream.onRemove = (recordId, call) => {
      if (call === 1) {
        upstream.records = upstream.records.filter((r) => r.recordId !== recordId); // it landed anyway
        throw new PokemonUpstreamError('unavailable', 'Pokémon answered 502.', { status: 502 });
      }
    };

    const undone = await undo(submitted.id);

    expect(upstream.removeCalls).toHaveLength(1);
    expect(outcomes(undone)).toEqual({ '1': 'removed' });
  });

  it('tries one record at most three times, fails it, and goes on with the next', async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();
    const r1 = upstream.recordOf('1');
    upstream.onRemove = (recordId) => {
      if (recordId === r1) throw new PokemonUpstreamError('unavailable', 'Pokémon answered 503.', { status: 503 });
    };

    const undone = await undo(submitted.id);

    expect(upstream.removeCalls.filter((c) => c.recordId === r1)).toHaveLength(3);
    expect(undone.items.find((i) => i.playerId === '1')).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/503/) });
    expect(outcomes(undone)['2']).toBe('removed');
    expect(undone.status).toBe('partial');
  });

  it('stops when Pokémon refuses the login: failed with the reason, the rest skipped', async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();
    upstream.onRemove = (_r, call) => {
      if (call === 2) throw new PokemonUpstreamError('needs_reconnect', 'Pokémon no longer accepts the saved login.');
    };

    const undone = await undo(submitted.id);

    expect(undone.status).toBe('failed');
    expect(undone.error).toMatch(/no longer accepts/);
    expect(Object.values(outcomes(undone)).sort()).toEqual(['removed', 'skipped']);
  });

  it('stops on a 403 from play-tools (the account may not delete attendance)', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    upstream.onRemove = () => {
      throw new PokemonUpstreamError('forbidden', 'play-tools refused the request (403).', { status: 403 });
    };

    const undone = await undo(submitted.id);

    expect(undone).toMatchObject({ status: 'failed', error: expect.stringMatching(/403/) });
    expect(outcomes(undone)).toEqual({ '1': 'skipped' });
  });

  it('sends no delete when play-tools is unreachable for the first re-read', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    upstream.onList = () => {
      throw new PokemonUpstreamError('unavailable', 'Pokémon answered 502.', { status: 502 });
    };

    const undone = await undo(submitted.id);

    expect(upstream.removeCalls).toEqual([]);
    expect(undone.status).toBe('failed');
  });
});

describe('an undo across a crash or a shutdown', () => {
  it('keeps each outcome as soon as its delete returns; after a crash nothing is deleted twice', async () => {
    sessionPlayers('1', '2', '3');
    const submitted = await submit();
    upstream.onRemove = (_r, call) => {
      if (call === 2) return new Promise(() => undefined) as never; // the process dies during the second delete
    };
    const started = await service.undo(L, submitted.id, 'o');
    for (let i = 0; i < 20 && upstream.removeCalls.length < 2; i += 1) await Promise.resolve().then(() => new Promise((r) => setTimeout(r, 0)));
    expect(upstream.removeCalls).toHaveLength(2);
    const r1 = upstream.removeCalls[0]!.recordId;
    expect(
      database.sqlite.prepare('select outcome from submission_item where submission_id = ? and record_id = ?').get(started.submissionId, r1),
    ).toEqual({ outcome: 'removed' });

    // A new process boots on the same database.
    service = build();
    expect(service.recoverInterrupted()).toBe(1);
    expect(service.get(L, started.submissionId).status).toBe('interrupted');
    upstream.onRemove = undefined;
    upstream.removeCalls = [];

    const again = await undo(submitted.id);

    expect(upstream.removeCalls.map((c) => c.recordId)).not.toContain(r1);
    expect(again.status).toBe('succeeded');
    expect(upstream.ids()).toEqual([]);
  });

  it('on shutdown finishes the delete in flight, starts no other, and ends interrupted', async () => {
    sessionPlayers('1', '2', '3');
    const submitted = await submit();
    onSleep = async (signal) => {
      void service.shutdown();
      throw signal.reason;
    };

    const undone = await undo(submitted.id);

    expect(upstream.removeCalls).toHaveLength(1);
    expect(undone.status).toBe('interrupted');
    expect(Object.values(outcomes(undone)).sort()).toEqual(['removed', 'skipped', 'skipped']);
    expect(database.sqlite.prepare('select count(*) n from submission_lock').get()).toEqual({ n: 0 });
  });
});

describe('an undo keeps the evidence in line with play-tools (ADR-0005)', () => {
  const kinds = (playerId: string, date: SessionDate = TUESDAY) =>
    sightings
      .on(L, date)
      .filter((x) => x.playerId === playerId)
      .map((x) => x.kind)
      .sort();
  const listed = () => sessions.getSession(L, TUESDAY).players.map((p) => p.playerId);

  it("clears removed players' tdf and manual sightings for the date, keeping other dates and upstream_existing", async () => {
    sessionPlayers('1', '2');
    sightings.record(L, TUESDAY, 'tdf', [id('1')]);
    sightings.record(L, TUESDAY, 'upstream_existing', [id('1')]);
    sightings.record(L, '2026-10-06' as SessionDate, 'manual', [id('1')]);
    sightings.record(L, TUESDAY, 'tdf', [id('2')]);
    const submitted = await submit();
    const r2 = upstream.recordOf('2');
    upstream.onRemove = (recordId) => (recordId === r2 ? 'removed' : undefined); // 2 stays upstream: failed

    const undone = await undo(submitted.id);

    expect(outcomes(undone)).toEqual({ '1': 'removed', '2': 'failed' });
    expect(kinds('1')).toEqual(['upstream_existing']);
    expect(kinds('1', '2026-10-06' as SessionDate)).toEqual(['manual']);
    expect(kinds('2')).toEqual(['manual', 'tdf']);
  });

  it('takes undone session players off the date, keeps regulars as regulars, and leaves the draft status alone', async () => {
    regulars('9');
    sessionPlayers('1');
    sessions.setRegularPresent(L, TUESDAY, id('9'), true);
    sightings.record(L, TUESDAY, 'tdf', [id('9')]);
    const submitted = await submit();
    expect(sessions.getSession(L, TUESDAY).status).toBe('submitted');

    await undo(submitted.id);

    const draft = sessions.getSession(L, TUESDAY);
    expect(draft.players).toEqual([]);
    expect(draft.regulars).toEqual([expect.objectContaining({ playerId: '9', present: false, inTournament: false })]);
    expect(draft.status).toBe('submitted');
    expect(roster.getPlayers(L, [id('1'), id('9')]).map((p) => p.playerId).sort()).toEqual(['1', '9']);
    expect(roster.regularIds(L).has(id('9'))).toBe(true);
  });

  it('does the same for a record someone already removed by hand', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    upstream.records = [];

    const undone = await undo(submitted.id);

    expect(outcomes(undone)).toEqual({ '1': 'already_removed' });
    expect(listed()).toEqual([]);
    expect(kinds('1')).toEqual([]);
  });

  it('so the next submit sends the regulars again but not the undone session players', async () => {
    regulars('9');
    sessionPlayers('1', '2');
    const submitted = await submit();
    await undo(submitted.id);
    upstream.bulkCalls = [];

    await submit();

    expect(upstream.bulkCalls).toEqual([['9']]);
  });

  it('a regular who is also on the session list comes off the list and stays a regular', async () => {
    sessionPlayers('1');
    roster.addRegular(L, { playerId: id('1'), name: 'Player 1' });
    const submitted = await submit();

    await undo(submitted.id);

    expect(listed()).toEqual([]);
    expect(roster.regularIds(L).has(id('1'))).toBe(true);
  });

  it('touches nothing for a player whose delete failed or was skipped', async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();
    upstream.onRemove = (_r, call) => {
      if (call === 1) throw new PokemonUpstreamError('needs_reconnect', 'Reconnect.');
    };

    await undo(submitted.id);

    expect(listed().sort()).toEqual(['1', '2']);
    expect(kinds('1')).toEqual(['manual']);
    expect(kinds('2')).toEqual(['manual']);
  });

  it('keeps a player still recorded for that date by another play session', async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();
    // An evening session the same day, submitted separately and not undone.
    const evening = database.sqlite
      .prepare(
        "insert into submission (league_id, session_date, play_session_id, play_session_label, started_by, started_at, status) values ('default', ?, 'ps-evening', 'Evening', 'o', 0, 'succeeded') returning id",
      )
      .get(TUESDAY) as { id: number };
    database.sqlite
      .prepare("insert into submission_item (submission_id, player_id, origin, outcome, record_id) values (?, '1', 'session', 'added', 'ev-1')")
      .run(evening.id);

    const undone = await undo(submitted.id);

    expect(outcomes(undone)).toEqual({ '1': 'removed', '2': 'removed' });
    expect(listed()).toEqual(['1']);
    expect(kinds('1')).toEqual(['manual']);
    expect(kinds('2')).toEqual([]);
  });

  it('rolls the outcome, the list and the sightings back together when the local write fails', async () => {
    sessionPlayers('1', '2');
    sightings.record(L, TUESDAY, 'tdf', [id('1')]);
    const submitted = await submit();
    const failing: SightingsService = {
      ...sightings,
      retract: (league, date, kind, ids) => {
        if (ids.includes(id('1'))) throw new Error('disk I/O error');
        sightings.retract(league, date, kind, ids);
      },
    };
    service = build({ sightings: failing });

    const undone = await undo(submitted.id);

    expect(undone.items.find((i) => i.playerId === '1')).toMatchObject({ outcome: 'failed', error: 'local_write_failed' });
    expect(outcomes(undone)['2']).toBe('removed');
    expect(listed()).toEqual(['1']);
    expect(kinds('1')).toEqual(['manual', 'tdf']);
  });

  it('rolls back too when taking the player off the list fails', async () => {
    sessionPlayers('1');
    const submitted = await submit();
    service = build({
      sessions: {
        ...sessions,
        removePlayer: () => {
          throw new Error('disk I/O error');
        },
      },
    });

    const undone = await undo(submitted.id);

    expect(undone.items[0]).toMatchObject({ outcome: 'failed', error: 'local_write_failed' });
    expect(listed()).toEqual(['1']);
    expect(kinds('1')).toEqual(['manual']);
  });
});

describe('history after an undo', () => {
  it("shows which undo removed each record, and the undo as kind undo of the submission", async () => {
    sessionPlayers('1', '2');
    const submitted = await submit();
    const r2 = upstream.recordOf('2');
    upstream.onRemove = (recordId) => (recordId === r2 ? 'removed' : undefined);
    const undone = await undo(submitted.id);

    const view = service.get(L, submitted.id);
    expect(view.items.find((i) => i.playerId === '1')!.removedBy).toBe(undone.id);
    expect(view.items.find((i) => i.playerId === '2')!.removedBy).toBeNull();
    expect(service.list(L).find((s) => s.id === undone.id)).toMatchObject({ kind: 'undo', undoOf: submitted.id });
    expect(undone.items.every((i) => i.removedBy === null)).toBe(true);
  });

  it('says whether each submission can be undone, and why not', async () => {
    sessionPlayers('1');
    upstream.has('1');
    const nothingAdded = await submit();
    sessionPlayers('2');
    const added = await submit();

    const byId = () => new Map(service.list(L).map((s) => [s.id, s]));
    expect(byId().get(nothingAdded.id)).toMatchObject({ undoable: false, undoBlockedReason: 'nothing_to_undo' });
    expect(byId().get(added.id)).toMatchObject({ undoable: true, undoBlockedReason: null });

    const undone = await undo(added.id);
    expect(byId().get(added.id)).toMatchObject({ undoable: false, undoBlockedReason: 'nothing_to_undo' });
    expect(byId().get(undone.id)).toMatchObject({ undoable: false, undoBlockedReason: 'not_undoable' });
  });

  it('stops counting an undone record in timesSubmitted', async () => {
    regulars('9');
    sessionPlayers('1');
    upstream.has('9');
    const submitted = await submit();
    expect(service.timesSubmitted(L)).toEqual(new Map([['1', 1], ['9', 1]]));

    await undo(submitted.id);

    expect(service.timesSubmitted(L)).toEqual(new Map([['9', 1]]));
  });
});

describe('undo never deletes what it did not add', () => {
  /** mulberry32: a small seeded PRNG, so a failing case can be replayed. */
  function rng(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('across 200 generated play-tools states, only records the target submission added are sent a delete', async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      database.close();
      setUp();
      const random = rng(seed);
      const pick = (n: number) => Math.floor(random() * n);
      const players = (from: number, count: number) => Array.from({ length: count }, (_, i) => String(from + i));

      upstream.has('900', { asStaff: true }); // the organizer
      for (const p of players(800, pick(4))) upstream.has(p); // entered in play-tools directly
      const mine = players(100, 1 + pick(6));
      sessionPlayers(...mine);
      if (random() < 0.5) regulars(...players(200, 1 + pick(3)));
      const target = await submit();
      // Another submission for the same session adds more people afterwards.
      sessionPlayers(...players(300, pick(4)));
      await submit();

      // play-tools changes in between: some of ours removed by hand, one reassigned.
      const added = new Set(target.items.filter((i) => i.outcome === 'added').map((i) => i.recordId!));
      upstream.records = upstream.records.filter((r) => !added.has(r.recordId) || random() < 0.7);
      if (random() < 0.3 && upstream.records.length > 0) {
        const k = pick(upstream.records.length);
        upstream.records[k] = { ...upstream.records[k]!, playerId: id('999') };
      }
      const before = new Map(upstream.records.map((r) => [r.recordId, r]));

      if (service.get(L, target.id).undoable) await undo(target.id);

      for (const call of upstream.removeCalls) {
        expect(added.has(call.recordId), `seed ${seed}: deleted ${call.recordId}`).toBe(true);
        expect(before.get(call.recordId)?.playerId, `seed ${seed}: deleted a reassigned record`).not.toBe('999');
      }
      for (const [recordId, record] of before) {
        if (!added.has(recordId)) expect(upstream.records, `seed ${seed}`).toContainEqual(record);
      }
    }
  }, 60_000);
});

