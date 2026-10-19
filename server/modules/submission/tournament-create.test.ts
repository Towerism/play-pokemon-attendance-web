import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { NewTournament } from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { type SessionsService, createSessionsService } from '../sessions/service';
import { type TournamentsService, createTournamentsService } from '../tournaments/service';
import { BROCK, GROUP, OLIVE, type StubTournament, stubPlayTools, templateBody, upstreamTournament } from '../tournaments/test-helpers';
import type { PlaySessionResolver } from './resolve';
import { type SubmissionService, createSubmissionService } from './service';

// The `tournament_create` job (#92, ADR-0010 decision 5) on the submission rails: adopt before create, one POST at a
// time and paced, a 5xx never resent, the window checked again before each send, rows held while it runs.
// Every wait is the fake clock's: `sleep` advances it, and late landings arrive when it passes their time.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
const SETTLE_MS = 3 * 60_000;
const POLL_MS = 15_000;
const MINUTE = 60_000;

let database: OpenDatabase;
let roster: RosterService;
let sightings: SightingsService;
let sessions: SessionsService;
let upstream: ReturnType<typeof stubPlayTools>;
let tournaments: TournamentsService;
let service: SubmissionService;
let clock: Date;
/** Every create sent: when (fake clock), as which connection, and the body. */
let posts: { at: number; as: number; tournament: NewTournament }[];
/** Decides each create (1-based): the default lands it at once. */
let onCreate: ((n: number, t: NewTournament) => Promise<CreateBehaviour | undefined> | CreateBehaviour | undefined) | undefined;
/** Tournaments that land in play-tools once the clock reaches `at`. */
let landings: { at: number; tournament: StubTournament }[];
let onSleep: ((signal: AbortSignal) => Promise<void> | void) | undefined;
let serial: number;

type CreateBehaviour = { fail: PokemonUpstreamError; landAfterMs?: number } | { land: false };

const noResolver: PlaySessionResolver = {
  resolve: () => Promise.reject(new Error('never')),
  find: () => Promise.reject(new Error('never')),
};
const noAttendance = {
  listPlaySessions: () => Promise.reject(new Error('this job never lists play sessions')),
  listAttendance: () => Promise.reject(new Error('never')),
  addAttendanceBulk: () => Promise.reject(new Error('never')),
  removeAttendance: () => Promise.reject(new Error('never')),
};

function stored(t: NewTournament, as: number): StubTournament {
  const organizer = upstream.state.professors.find((p) => p.id === as)!.professorPlayerId!;
  return upstreamTournament(`g-${++serial}`, t.startsAt.toISOString(), { name: t.name, products: [t.product], organizer, category: t.category });
}

function land(): void {
  for (const l of landings.filter((x) => x.at <= clock.getTime())) upstream.state.tournaments.push(l.tournament);
  landings = landings.filter((x) => x.at > clock.getTime());
}

function build(over: { tournamentDelayMs?: number } = {}): SubmissionService {
  return createSubmissionService({
    db: database.db,
    sessions,
    roster,
    sightings,
    connections: upstream.connections,
    gateway: () => noAttendance,
    staffGateway: () => {
      throw new Error('a tournament job never uses the staff gateway');
    },
    tournamentGateway: (connectionId) =>
      ({
        ...upstream.gateway(connectionId),
        async createTournament(t: NewTournament) {
          posts.push({ at: clock.getTime(), as: connectionId, tournament: t });
          const behaviour = await onCreate?.(posts.length, t);
          if (behaviour && 'fail' in behaviour) {
            if (behaviour.landAfterMs !== undefined) landings.push({ at: clock.getTime() + behaviour.landAfterMs, tournament: stored(t, connectionId) });
            throw behaviour.fail;
          }
          const created = stored(t, connectionId);
          if (!(behaviour && 'land' in behaviour)) upstream.state.tournaments.push(created);
          return { tournamentId: created.id };
        },
      }) as never,
    staffing: {} as never,
    tournaments,
    resolver: noResolver,
    timeZone: TZ,
    now: () => clock,
    sleep: async (ms, signal) => {
      await onSleep?.(signal);
      if (signal.aborted) throw signal.reason;
      clock = new Date(clock.getTime() + ms);
      land();
    },
    settleMs: SETTLE_MS,
    settlePollMs: POLL_MS,
    ...(over.tournamentDelayMs !== undefined && { tournamentDelayMs: over.tournamentDelayMs }),
  });
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  roster = createRosterService({ db: database.db });
  sightings = createSightingsService({ db: database.db });
  sessions = createSessionsService({ db: database.db, roster, sightings });
  upstream = stubPlayTools();
  upstream.state.professors.push({ ...BROCK });
  // Wednesday 2026-10-14, noon in Chicago.
  clock = new Date('2026-10-14T17:00:00Z');
  tournaments = createTournamentsService({ db: database.db, connections: upstream.connections, gateway: upstream.gateway, timeZone: TZ, now: () => clock });
  posts = [];
  onCreate = undefined;
  landings = [];
  onSleep = undefined;
  serial = 0;
  service = build();
});
afterEach(() => database.close());

type Row = { id: number; state: string; tournament_id: string | null; display_id: string | null; upstream_status: string | null; error_code: string | null; last_attempt_at: number | null };
const rowOf = (id: number) => database.sqlite.prepare('select * from planned_tournament where id = ?').get(id) as Row;
const setRow = (id: number, set: string) => database.sqlite.prepare(`update planned_tournament set ${set} where id = ?`).run(id);

function customTemplate(overrides: Parameters<typeof templateBody>[0] = {}) {
  return tournaments.createTemplate(L, templateBody({ name: 'Friday Cup {date}', type: { kind: 'custom' }, ...overrides }));
}
const plan = (templateId: number, localDate: string, startTime?: string) =>
  tournaments.createPlanned(L, { templateId, localDate, ...(startTime && { startTime }) }).plannedId!;

async function create(plannedIds: number[], opts: { acknowledgeShortNotice?: boolean; retryUnknown?: boolean } = {}) {
  const { submissionId } = await service.createTournaments(L, {
    plannedIds,
    acknowledgeShortNotice: opts.acknowledgeShortNotice ?? false,
    retryUnknown: opts.retryUnknown ?? false,
    startedBy: 'organizer',
  });
  await service.idle();
  return service.get(L, submissionId);
}

/** A promise the test resolves: holds a create at the fake's door. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  let arrived!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  return { opened, open, reached, arrived };
}

describe('creating planned tournaments', () => {
  it('holds the rows, creates each as its organizer in start order, and reconciles them', async () => {
    const olive = customTemplate();
    const brock = customTemplate({ name: 'Brock Cup {date}', organizerPlayerId: BROCK.professorPlayerId! as never });
    const a = plan(olive.id, '2026-11-06');
    const b = plan(brock.id, '2026-11-01');
    const held = gate();
    onCreate = async (n) => {
      if (n === 1) {
        held.arrived();
        await held.opened;
      }
      return undefined;
    };

    const started = service.createTournaments(L, { plannedIds: [a, b], acknowledgeShortNotice: false, retryUnknown: false, startedBy: 'organizer' });
    await held.reached;
    expect([rowOf(a).state, rowOf(b).state]).toEqual(['creating', 'creating']);
    held.open();
    const { submissionId } = await started;
    await service.idle();
    const job = service.get(L, submissionId);

    expect(posts.map((p) => [p.as, p.tournament.name])).toEqual([
      [BROCK.id, 'Brock Cup 2026-11-01'],
      [OLIVE.id, 'Friday Cup 2026-11-06'],
    ]);
    expect(job).toMatchObject({ kind: 'tournament_create', status: 'succeeded', playSessionLabel: 'Create 2 tournaments', professor: null, counts: { added: 2 } });
    expect(job.tournamentItems.map((i) => [i.position, i.plannedTournamentId, i.outcome, i.label])).toEqual([
      [0, b, 'created', 'Brock Cup 2026-11-01 · 2026-11-01'],
      [1, a, 'created', 'Friday Cup 2026-11-06 · 2026-11-06'],
    ]);
    expect(rowOf(a)).toMatchObject({ state: 'created', tournament_id: 'g-2', display_id: '26-10-g-2', upstream_status: 'sanctioned' });
    expect(job.tournamentItems[1]!.sentAt).not.toBeNull();
  });

  it("drops coverage's cached listings once the create job has ended (#95)", async () => {
    const statuses: string[][] = [];
    (tournaments.requiredEvents as { listingsChanged: () => void }).listingsChanged = () =>
      statuses.push((database.sqlite.prepare('select status from submission order by id').all() as { status: string }[]).map((r) => r.status));
    await create([plan(customTemplate().id, '2026-11-06')]);
    expect(statuses).toEqual([['succeeded']]);
  });

  it('names the organizer on a job whose tournaments all share one', async () => {
    const t = customTemplate();
    const job = await create([plan(t.id, '2026-11-06')]);
    expect(job).toMatchObject({ playSessionLabel: 'Create 1 tournament', professor: { playerId: OLIVE.professorPlayerId, name: 'Olive Organizer' } });
  });

  it('adopts a tournament the organizer already has instead of creating one', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    upstream.state.tournaments = [upstreamTournament('g-hand', '2026-11-07T00:00:00Z', { name: 'friday cup 2026-11-06', applicationState: 'approval-pending' })];
    const job = await create([id]);
    expect(posts).toEqual([]);
    expect(job.tournamentItems[0]).toMatchObject({ outcome: 'already_exists', tournamentId: 'g-hand' });
    expect(rowOf(id)).toMatchObject({ state: 'created', tournament_id: 'g-hand', upstream_status: 'approval-pending' });
    expect(job).toMatchObject({ status: 'succeeded', counts: { alreadyPresent: 1 } });
  });

  it('creates two identical slots as two tournaments: the second never adopts the first', async () => {
    const t = customTemplate();
    const first = plan(t.id, '2026-11-06');
    const second = (database.sqlite
      .prepare("insert into planned_tournament (league_id, template_id, local_date, start_time, overrides, state, created_at) values (?, ?, '2026-11-06', '18:00', '{}', 'planned', 0) returning id")
      .get(L, t.id) as { id: number }).id;
    await create([first, second]);
    expect(posts).toHaveLength(2);
    expect(rowOf(first).tournament_id).not.toBe(rowOf(second).tournament_id);
  });

  it('fails a row that can’t be created before any write, and goes on with the rest', async () => {
    const gone = customTemplate({ venue: { id: '00000000-0000-4000-8000-000000000099', label: 'Old Shop', timeZone: TZ, country: 'US' } });
    const ok = customTemplate();
    const a = plan(gone.id, '2026-11-06');
    const b = plan(ok.id, '2026-11-13');
    const job = await create([a, b]);
    expect(job.tournamentItems.map((i) => [i.outcome, i.errorCode])).toEqual([
      ['failed', 'venue_not_found'],
      ['created', null],
    ]);
    expect(rowOf(a)).toMatchObject({ state: 'failed', error_code: 'venue_not_found' });
    expect(job).toMatchObject({ status: 'partial', counts: { added: 1, failed: 1 } });
  });

  it('checks the window again before each send: a job past midnight refuses an item that fell out of it', async () => {
    // 23:59:58 on Wednesday in Chicago: the window starts on the 12th until midnight, then on the 13th.
    clock = new Date('2026-10-15T04:59:58Z');
    const t = customTemplate();
    const noon = plan(t.id, '2026-10-12', '12:00');
    const evening = plan(t.id, '2026-10-12', '18:00');
    const job = await create([noon, evening]);
    expect(posts.map((p) => p.tournament.startsAt.toISOString())).toEqual(['2026-10-12T17:00:00.000Z']);
    expect(job.tournamentItems[1]).toMatchObject({ outcome: 'date_too_far_past', sentAt: null });
    expect(rowOf(evening)).toMatchObject({ state: 'failed', error_code: 'date_too_far_past' });
  });

  it('keeps creates at least 5 s apart by default, and never under 2 s', async () => {
    const t = customTemplate();
    const ids = [plan(t.id, '2026-11-06'), plan(t.id, '2026-11-13'), plan(t.id, '2026-11-20')];
    await create(ids);
    const gaps = (p: typeof posts) => p.slice(1).map((x, i) => x.at - p[i]!.at);
    expect(gaps(posts).every((g) => g >= 5_000)).toBe(true);

    service = build({ tournamentDelayMs: 0 });
    posts = [];
    const more = [plan(t.id, '2026-11-27'), plan(t.id, '2026-12-04'), plan(t.id, '2026-12-11')];
    await create(more);
    expect(gaps(posts)).toEqual([2_000, 2_000]);
  });
});

describe('a create that may have landed (5xx, timeout)', () => {
  const unavailable = () => new PokemonUpstreamError('unavailable', 'Pokémon took too long.', { status: 502, upstream: { correlationId: 'corr-502' } });

  it('re-lists through the settle window and adopts it when it shows up, with one POST', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    onCreate = () => ({ fail: unavailable(), landAfterMs: MINUTE });
    const job = await create([id]);
    expect(posts).toHaveLength(1);
    expect(job.tournamentItems[0]).toMatchObject({ outcome: 'created', tournamentId: 'g-1' });
    expect(rowOf(id)).toMatchObject({ state: 'created', tournament_id: 'g-1' });
  });

  it('ends unknown when it lands after the window, never resends, and is linked on the next read', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    onCreate = () => ({ fail: unavailable(), landAfterMs: 4 * MINUTE });
    const job = await create([id]);

    expect(posts).toHaveLength(1);
    expect(job.status).toBe('failed');
    expect(job.tournamentItems[0]).toMatchObject({
      outcome: 'unknown',
      support: {
        action: 'create',
        league: { displayId: 'L5012' },
        tournament: { displayId: null, name: 'Friday Cup 2026-11-06', date: '2026-11-06' },
        professor: { playerId: OLIVE.professorPlayerId, name: 'Olive Organizer' },
        status: 502,
        correlationId: 'corr-502',
      },
    });
    expect(job.tournamentItems[0]!.error).toMatch(/may still appear in play-tools/);
    expect(rowOf(id).state).toBe('unknown');

    clock = new Date(clock.getTime() + 2 * MINUTE);
    land();
    await tournaments.upcoming(L, {});
    expect(rowOf(id)).toMatchObject({ state: 'created', tournament_id: 'g-1' });
    expect(posts).toHaveLength(1);
  });

  it('ends unknown at once when re-listing fails', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    onCreate = () => {
      upstream.state.failNext.set('listTournaments', new PokemonUpstreamError('unavailable', 'Still down.'));
      return { fail: unavailable() };
    };
    const job = await create([id]);
    expect(job.tournamentItems[0]!.outcome).toBe('unknown');
    expect(posts).toHaveLength(1);
  });

  it('treats a 2xx without a guid as may-have-landed too', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    onCreate = () => ({ fail: new PokemonUpstreamError('unexpected_shape', 'Odd answer.'), landAfterMs: 0 });
    const job = await create([id]);
    expect(job.tournamentItems[0]!.outcome).toBe('created');
  });

  it('retries an unknown row only when confirmed: adopting it if it landed, else one POST', async () => {
    const t = customTemplate();
    const late = plan(t.id, '2026-11-06');
    const never = plan(t.id, '2026-11-13');
    onCreate = (n) => ({ fail: unavailable(), ...(n === 1 && { landAfterMs: 10 * MINUTE }) });
    await create([late, never]);
    expect([rowOf(late).state, rowOf(never).state]).toEqual(['unknown', 'unknown']);
    clock = new Date(clock.getTime() + 10 * MINUTE);
    land();
    onCreate = undefined;

    await expect(service.createTournaments(L, { plannedIds: [late], acknowledgeShortNotice: false, retryUnknown: false, startedBy: 'organizer' })).rejects.toMatchObject({
      code: 'retry_not_confirmed',
    });
    posts = [];
    const retried = await create([late, never], { retryUnknown: true });
    expect(retried.tournamentItems.map((i) => i.outcome)).toEqual(['already_exists', 'created']);
    expect(posts).toHaveLength(1);
  });
});

describe('refusals', () => {
  it('records play-tools’ refusal with support details and goes on', async () => {
    const t = customTemplate();
    const a = plan(t.id, '2026-11-06');
    const b = plan(t.id, '2026-11-13');
    onCreate = (n) =>
      n === 1
        ? { fail: new PokemonUpstreamError('refused', 'Creating a tournament: play-tools refused it: name: too long', { status: 400, upstream: { code: 'op.generic.bad_request', message: 'name: too long', correlationId: 'corr-1' } }) }
        : undefined;
    const job = await create([a, b]);
    expect(job.tournamentItems[0]).toMatchObject({
      outcome: 'refused',
      errorCode: 'refused',
      error: 'Creating a tournament: play-tools refused it: name: too long',
      support: { status: 400, code: 'op.generic.bad_request', message: 'name: too long', correlationId: 'corr-1', sentAt: expect.any(String) },
    });
    expect(rowOf(a)).toMatchObject({ state: 'failed', error_code: 'refused' });
    expect(job.tournamentItems[1]!.outcome).toBe('created');
    expect(JSON.stringify(job)).not.toMatch(/activity_division_info|Bearer|token/i);
  });

  it('stops the job on a 403: the rest are skipped and released', async () => {
    const t = customTemplate();
    const ids = [plan(t.id, '2026-11-06'), plan(t.id, '2026-11-13'), plan(t.id, '2026-11-20')];
    setRow(ids[2]!, 'last_attempt_at = 1');
    onCreate = (n) => (n === 2 ? { fail: new PokemonUpstreamError('forbidden', 'Refused.', { status: 403 }) } : undefined);
    const job = await create(ids);
    expect(job.tournamentItems.map((i) => [i.outcome, i.errorCode])).toEqual([
      ['created', null],
      ['refused', 'forbidden'],
      ['skipped', null],
    ]);
    expect(job.status).toBe('failed');
    expect(rowOf(ids[1]!)).toMatchObject({ state: 'failed', error_code: 'forbidden' });
    // Sent once before, by an earlier job: it may still land.
    expect(rowOf(ids[2]!).state).toBe('unknown');
  });

  it('stops the job when the organizer needs a reconnect mid-run', async () => {
    const t = customTemplate();
    const ids = [plan(t.id, '2026-11-06'), plan(t.id, '2026-11-13')];
    onCreate = (n) => {
      if (n === 1) upstream.state.professors[0]!.status = 'needs_reconnect';
      return undefined;
    };
    const job = await create(ids);
    expect(job.tournamentItems.map((i) => [i.outcome, i.errorCode])).toEqual([
      ['created', null],
      ['refused', 'needs_reconnect'],
    ]);
  });
});

describe('when the app stops', () => {
  it('on boot, a row whose create was sent becomes unknown, and an unsent one is released', async () => {
    const t = customTemplate();
    const sent = plan(t.id, '2026-11-06');
    const unsent = plan(t.id, '2026-11-13');
    const triedBefore = plan(t.id, '2026-11-20');
    setRow(triedBefore, 'last_attempt_at = 1');
    const held = gate();
    onCreate = async () => {
      held.arrived();
      await new Promise(() => {}); // the crash: never answers
      return undefined;
    };
    void service.createTournaments(L, { plannedIds: [sent, unsent, triedBefore], acknowledgeShortNotice: false, retryUnknown: false, startedBy: 'organizer' });
    await held.reached;

    const afterBoot = build();
    expect(afterBoot.recoverInterrupted()).toBe(1);
    expect([rowOf(sent).state, rowOf(unsent).state, rowOf(triedBefore).state]).toEqual(['unknown', 'planned', 'unknown']);
    const job = afterBoot.list(L)[0]!;
    expect(job.status).toBe('interrupted');
    expect(afterBoot.get(L, job.id).tournamentItems.map((i) => i.outcome)).toEqual(['unknown', 'skipped', 'skipped']);
  });

  it('on shutdown during the wait before the next create, stops without sending it', async () => {
    const t = customTemplate();
    const a = plan(t.id, '2026-11-06');
    const b = plan(t.id, '2026-11-13');
    onSleep = () => {
      void service.shutdown();
    };
    const { submissionId } = await service.createTournaments(L, { plannedIds: [a, b], acknowledgeShortNotice: false, retryUnknown: false, startedBy: 'organizer' });
    await service.idle();
    expect(posts).toHaveLength(1);
    expect([rowOf(a).state, rowOf(b).state]).toEqual(['created', 'planned']);
    expect(service.get(L, submissionId).status).toBe('interrupted');
  });
});

describe('on the rails', () => {
  it('holds the league’s lease: nothing else starts while it runs', async () => {
    const t = customTemplate();
    const a = plan(t.id, '2026-11-06');
    const b = plan(t.id, '2026-11-13');
    const held = gate();
    onCreate = async () => {
      held.arrived();
      await held.opened;
      return undefined;
    };
    const first = service.createTournaments(L, { plannedIds: [a], acknowledgeShortNotice: false, retryUnknown: false, startedBy: 'organizer' });
    await held.reached;
    await expect(service.createTournaments(L, { plannedIds: [b], acknowledgeShortNotice: false, retryUnknown: false, startedBy: 'organizer' })).rejects.toMatchObject({
      code: 'submission_running',
    });
    expect(rowOf(b).state).toBe('planned');
    held.open();
    await first;
    await service.idle();
  });

  it('retries only the rows still planned or failed, leaving unknown ones to Retry create', async () => {
    const t = customTemplate();
    const ids = [plan(t.id, '2026-11-06'), plan(t.id, '2026-11-13'), plan(t.id, '2026-11-20')];
    onCreate = (n) =>
      n === 2
        ? { fail: new PokemonUpstreamError('refused', 'No.', { status: 400 }) }
        : n === 3
          ? { fail: new PokemonUpstreamError('unavailable', 'Down.', { status: 503 }) }
          : undefined;
    const first = await create(ids);
    expect(first.status).toBe('partial');
    onCreate = undefined;

    const { submissionId } = await service.retry(L, first.id, 'organizer');
    await service.idle();
    const retry = service.get(L, submissionId);
    expect(retry).toMatchObject({ retryOf: first.id, status: 'succeeded' });
    expect(retry.tournamentItems.map((i) => i.plannedTournamentId)).toEqual([ids[1]]);
  });

  it('refuses a retry when a row has become short notice since', async () => {
    const t = customTemplate();
    const id = plan(t.id, '2026-10-22');
    onCreate = () => ({ fail: new PokemonUpstreamError('refused', 'No.', { status: 400 }) });
    const first = await create([id]);
    clock = new Date('2026-10-17T17:00:00Z');
    await expect(service.retry(L, first.id, 'organizer')).rejects.toMatchObject({ code: 'short_notice_not_acknowledged' });
  });

  it('records each item’s short notice; the job’s starter acknowledged it', async () => {
    const t = customTemplate();
    const job = await create([plan(t.id, '2026-10-16'), plan(t.id, '2026-11-06')], { acknowledgeShortNotice: true });
    expect(job.startedBy).toBe('organizer');
    expect(job.tournamentItems.map((i) => i.shortNotice)).toEqual([true, false]);
  });
});

describe('create through a date', () => {
  function weekly() {
    const t = customTemplate({ name: 'Tuesday Cup {date}' });
    const scaffold = tournaments.createScaffold(L, { name: 'Tuesday Cup', slots: [{ templateId: t.id, dayOffset: 0, startTime: null }] });
    return tournaments.createSchedule(L, { scaffoldId: scaffold.id, rule: { kind: 'weekly', weekday: 2, every: 1 }, startsOn: '2026-10-01', endsOn: null, horizonWeeks: 2 });
  }

  it('creates every planned row through the date in one job, and marks the schedule', async () => {
    const schedule = weekly();
    const { submissionId } = await service.createThrough(L, { scheduleId: schedule.id, date: '2026-11-10', acknowledgeShortNotice: true, startedBy: 'organizer' });
    await service.idle();
    const job = service.get(L, submissionId);
    expect(job).toMatchObject({ status: 'succeeded', playSessionLabel: 'Create Tuesday Cup through 2026-11-10' });
    expect(posts.map((p) => p.tournament.name)).toEqual(['Tuesday Cup 2026-10-13', 'Tuesday Cup 2026-10-20', 'Tuesday Cup 2026-10-27', 'Tuesday Cup 2026-11-03', 'Tuesday Cup 2026-11-10']);
    expect(tournaments.listSchedules(L)[0]!.createdThrough).toBe('2026-11-10');
  });

  it('refuses more than 60, suggesting a nearer date, and an empty list', async () => {
    const schedule = weekly();
    await expect(service.createThrough(L, { scheduleId: schedule.id, date: '2027-12-31', acknowledgeShortNotice: true, startedBy: 'organizer' })).rejects.toMatchObject({
      code: 'date_too_far_ahead',
    });
    const t = tournaments.listTemplates(L, {})[0]!;
    const scaffold = tournaments.createScaffold(L, { name: 'Twice', slots: [{ templateId: t.id, dayOffset: 0, startTime: '10:00' }, { templateId: t.id, dayOffset: 0, startTime: '14:00' }] });
    const busy = tournaments.createSchedule(L, { scaffoldId: scaffold.id, rule: { kind: 'weekly', weekday: 6, every: 1 }, startsOn: '2026-10-01', endsOn: null, horizonWeeks: 2 });
    await expect(service.createThrough(L, { scheduleId: busy.id, date: '2027-06-30', acknowledgeShortNotice: true, startedBy: 'organizer' })).rejects.toMatchObject({
      code: 'too_many_tournaments',
      details: { count: expect.any(Number), suggestedThrough: expect.any(String) },
    });
    await expect(service.createThrough(L, { scheduleId: schedule.id, date: '2026-10-12', acknowledgeShortNotice: true, startedBy: 'organizer' })).rejects.toMatchObject({
      code: 'nothing_to_create',
    });
    expect(posts).toEqual([]);
  });
});

void GROUP;
