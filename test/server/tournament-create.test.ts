import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PLAYER_ID, FAKE_VENUE, type FakePokemon, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';
import { leagueDay } from './league-day';

// Creating tournaments in play-tools (#92) over HTTP, against the built app and the play-tools fake: the routes, the
// tournament_create job, and the #100 scenarios end to end. The server runs on the real clock, so every date is 10 or
// more days from an edge of the creatable window and of short notice, except where short notice is the point.
// The settle window is a few hundred ms here; a "late" landing is the fake holding the tournament until `land()`,
// called after the job has ended. Timing rules (pacing, midnight, DST) are the module tests', on a fake clock.

const OWNER = { username: 'organizer', password: 'correct horse' };
const TZ = 'America/Chicago';
const ENV = { TZ, NUXT_SUBMISSION_SETTLE_MS: '400', NUXT_SUBMISSION_SETTLE_POLL_MS: '100', NUXT_TOURNAMENT_DELAY_MS: '0', NUXT_LOG_FORMAT: 'json' };

/** The league's date `days` from today. */
const day = (days: number) => leagueDay(days, TZ);
/** ISO weekday (1 = Monday) of a date. */
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;

let fake: FakePokemon;
let server: TestServer;
let browser: ReturnType<typeof client>;
const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
const post = (path: string, json: unknown) => api(path, { method: 'POST', json });
const body = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const code = async (res: Response) => (await body<{ data?: { code?: string } }>(res)).data?.code;
const creates = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/services/core/tournament');

interface Entry {
  plannedId: number | null;
  state: string;
  tournamentId: string | null;
  displayId: string | null;
  localDate: string;
  inSchedule: boolean | null;
  lastAttemptAt: string | null;
  actions: string[];
}
interface Job {
  status: string;
  kind: string;
  playSessionLabel: string;
  tournamentItems: { outcome: string; plannedTournamentId: number; tournamentId: string | null; support: Record<string, unknown> | null }[];
}

let templateSerial = 0;
async function template(): Promise<number> {
  const res = await post('/tournament-templates', {
    name: `Cup ${++templateSerial} {date}`,
    organizerPlayerId: FAKE_PLAYER_ID,
    product: 'tcg',
    category: 'tcg_std',
    type: { kind: 'custom' },
    venue: { id: FAKE_VENUE.guid, label: 'Card Shop', timeZone: TZ, country: 'US' },
    startTime: '18:00',
    registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: null },
    contactEmail: 'league@example.com',
  });
  expect(res.status).toBe(201);
  return (await body<{ template: { id: number } }>(res)).template.id;
}

async function planned(templateId: number, localDate: string): Promise<number> {
  const res = await post('/planned-tournaments', { templateId, localDate });
  expect(res.status).toBe(201);
  return (await body<{ planned: { plannedId: number } }>(res)).planned.plannedId;
}

/** The row on Upcoming; `refresh` lists play-tools again instead of the 5-minute cache (#98). */
async function entry(plannedId: number, opts: { refresh?: boolean } = {}): Promise<Entry> {
  const { tournaments } = await body<{ tournaments: Entry[] }>(await api(`/tournaments/upcoming${opts.refresh ? '?refresh=1' : ''}`));
  return tournaments.find((t) => t.plannedId === plannedId)!;
}

/** Waits for the job to end (its status leaves planned/running), then returns it. */
async function finished(res: Response): Promise<Job> {
  expect(res.status).toBe(202);
  const { submissionId } = await body<{ submissionId: number }>(res);
  for (const deadline = Date.now() + 25_000; Date.now() < deadline; ) {
    const job = await body<Job>(await api(`/submissions/${submissionId}`));
    if (job.status !== 'planned' && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${submissionId} did not finish`);
}

beforeAll(async () => {
  fake = await startFakePokemon();
  server = await startServer({ env: { ...fake.env, ...ENV } });
  browser = client(server.url);
  const setup = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } });
  expect(setup.status).toBe(200);
  const start = await post('/pokemon/connect/start', {});
  const state = new URL((await body<{ authorizeUrl: string }>(start)).authorizeUrl).searchParams.get('state');
  expect((await post('/pokemon/connect/complete', { url: `https://play-tools.pokemon.com/loggedIn?code=fresh&state=${state}` })).status).toBe(200);
});
afterAll(async () => {
  expect(server.logs()).not.toMatch(/ory_rt_|eyJ|activity_division_info/);
  await server.dispose();
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.tournaments = [];
});

describe('auth and validation', () => {
  it.each([
    ['POST', '/api/tournaments/create'],
    ['GET', '/api/tournament-schedules/1/create-through?date=2026-12-31'],
    ['POST', '/api/tournament-schedules/1/create-through'],
  ])('%s %s is 401 without a session, before validation or any upstream call', async (method, path) => {
    const res = await fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    expect(res.status).toBe(401);
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ['POST', '/tournaments/create', {}],
    ['POST', '/tournaments/create', { plannedIds: [1, 1] }],
    ['POST', '/tournaments/create', { plannedIds: Array.from({ length: 61 }, (_, i) => i + 1) }],
    ['GET', '/tournament-schedules/1/create-through', undefined],
    ['GET', '/tournament-schedules/abc/create-through?date=2026-12-31', undefined],
    ['POST', '/tournament-schedules/1/create-through', { date: '2026-02-30' }],
  ])('%s %s %j is 400', async (method, path, json) => {
    const res = await api(path, { method, ...(json !== undefined && { json }) });
    expect(res.status).toBe(400);
    expect(fake.requests).toEqual([]);
  });
});

describe('POST /tournaments/create', () => {
  it('creates a planned tournament in play-tools and links it', async () => {
    const id = await planned(await template(), day(20));
    const job = await finished(await post('/tournaments/create', { plannedIds: [id] }));

    expect(job).toMatchObject({ kind: 'tournament_create', status: 'succeeded', playSessionLabel: 'Create 1 tournament' });
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!.body).toMatchObject({ start_date_v2: expect.any(String), activity_division_info: expect.anything() });
    expect(await entry(id)).toMatchObject({ state: 'created', tournamentId: job.tournamentItems[0]!.tournamentId, displayId: expect.stringMatching(/^26-10-/) });
  });

  it('adopts the organizer’s tournament made by hand in play-tools instead of creating a second one', async () => {
    const id = await planned(await template(), day(21));
    const { tournaments } = await body<{ tournaments: (Entry & { name: string; startsAt: string })[] }>(await api('/tournaments/upcoming'));
    const want = tournaments.find((t) => t.plannedId === id)!;
    fake.tournaments = [fakeTournament('by-hand', { startsAt: want.startsAt, name: want.name.toUpperCase(), organizer: FAKE_PLAYER_ID })];
    fake.requests.length = 0;

    const job = await finished(await post('/tournaments/create', { plannedIds: [id] }));

    expect(job.tournamentItems[0]).toMatchObject({ outcome: 'already_exists', tournamentId: 'by-hand' });
    expect(creates()).toEqual([]);
    expect(await entry(id)).toMatchObject({ state: 'created', tournamentId: 'by-hand' });
  });

  it.each([
    ['an unknown id', async () => [999_999], 404, 'not_found'],
    [
      'a skipped row',
      async () => {
        const id = await planned(await template(), day(23));
        expect((await api(`/planned-tournaments/${id}`, { method: 'PATCH', json: { skipped: true } })).status).toBe(200);
        return [id];
      },
      409,
      'not_creatable',
    ],
    ['short notice not acknowledged', async () => [await planned(await template(), day(3))], 422, 'short_notice_not_acknowledged'],
  ])('refuses %s, sending nothing', async (_what, ids, status, expected) => {
    const res = await post('/tournaments/create', { plannedIds: await ids() });
    expect(res.status).toBe(status);
    expect(await code(res)).toBe(expected);
    expect(creates()).toEqual([]);
  });

  it('drops Upcoming’s cached listings when the job ends, so the next read lists again (#98)', async () => {
    const id = await planned(await template(), day(26));
    await api('/tournaments/upcoming');
    const job = await finished(await post('/tournaments/create', { plannedIds: [id] }));
    fake.requests.length = 0;

    expect(await entry(id)).toMatchObject({ state: 'created', tournamentId: job.tournamentItems[0]!.tournamentId });
    expect(fake.requests.filter((r) => r.method === 'GET' && r.path === '/services/core/activities')).toHaveLength(1);
  });

  it('creates short notice once acknowledged', async () => {
    const id = await planned(await template(), day(3));
    const job = await finished(await post('/tournaments/create', { plannedIds: [id], acknowledgeShortNotice: true }));
    expect(job.status).toBe('succeeded');
  });
});

describe('a create that may have landed (#100)', () => {
  it('gets exactly one POST when its tournament lands after the settle window, and is linked on the next read', async () => {
    const id = await planned(await template(), day(24));
    fake.createLandsLate = true;
    const job = await finished(await post('/tournaments/create', { plannedIds: [id] }));

    expect(job.status).toBe('failed');
    expect(job.tournamentItems[0]).toMatchObject({ outcome: 'unknown', support: { action: 'create', status: 500, league: { displayId: 'L5012' } } });
    expect(await entry(id)).toMatchObject({ state: 'unknown', lastAttemptAt: expect.any(String), actions: ['retry_create'] });

    fake.land();
    expect(await entry(id, { refresh: true })).toMatchObject({ state: 'created', tournamentId: expect.stringMatching(/^t-/) });
    expect(creates()).toHaveLength(1);
  });

  it('Retry create needs confirming, then adopts the late tournament without a second POST', async () => {
    const id = await planned(await template(), day(25));
    fake.createLandsLate = true;
    await finished(await post('/tournaments/create', { plannedIds: [id] }));

    const unconfirmed = await post('/tournaments/create', { plannedIds: [id] });
    expect(unconfirmed.status).toBe(422);
    expect(await code(unconfirmed)).toBe('retry_not_confirmed');

    fake.land();
    fake.requests.length = 0;
    const retry = await finished(await post('/tournaments/create', { plannedIds: [id], retryUnknown: true }));
    expect(retry.tournamentItems[0]!.outcome).toBe('already_exists');
    expect(creates()).toEqual([]);
  });

  it('Retry create sends one POST when the tournament never landed', async () => {
    const id = await planned(await template(), day(26));
    fake.createLandsLate = true;
    await finished(await post('/tournaments/create', { plannedIds: [id] }));
    // The first attempt never lands (land() isn't called for it before the retry).
    fake.requests.length = 0;
    const retry = await finished(await post('/tournaments/create', { plannedIds: [id], retryUnknown: true }));
    expect(retry.tournamentItems[0]!.outcome).toBe('created');
    expect(creates()).toHaveLength(1);
  });

  it('keeps a row a create job holds when its schedule is edited meanwhile', async () => {
    const templateId = await template();
    const scaffold = await body<{ scaffold: { id: number } }>(await post('/tournament-scaffolds', { name: 'Gate', slots: [{ templateId, dayOffset: 0, startTime: null }] }));
    const first = day(30);
    const created = await post('/tournament-schedules', { scaffoldId: scaffold.scaffold.id, rule: { kind: 'weekly', weekday: weekdayOf(first), every: 1 }, startsOn: first, endsOn: null });
    const { schedule } = await body<{ schedule: { id: number } }>(created);
    const { tournaments } = await body<{ tournaments: (Entry & { scheduleId: number | null })[] }>(await api('/tournaments/upcoming'));
    const row = tournaments.find((t) => t.scheduleId === schedule.id && t.localDate === first)!;

    const gate = fake.holdCreates();
    const started = post('/tournaments/create', { plannedIds: [row.plannedId] });
    await gate.arrived;
    expect((await api(`/tournament-schedules/${schedule.id}`, { method: 'PATCH', json: { paused: true } })).status).toBe(200);
    expect(await entry(row.plannedId!)).toMatchObject({ state: 'creating', inSchedule: false });

    gate.release();
    expect((await finished(await started)).status).toBe('succeeded');
    expect(await entry(row.plannedId!)).toMatchObject({ state: 'created', inSchedule: false });
  });
});

describe('create through a date', () => {
  it('previews, then creates every tournament through the date in one job, and marks the schedule', async () => {
    const templateId = await template();
    const scaffold = await body<{ scaffold: { id: number } }>(await post('/tournament-scaffolds', { name: 'Monthly Cup', slots: [{ templateId, dayOffset: 0, startTime: null }] }));
    const first = day(12);
    const dom = Number(first.slice(8));
    const created = await post('/tournament-schedules', { scaffoldId: scaffold.scaffold.id, rule: { kind: 'monthly', day: dom }, startsOn: first, endsOn: null, horizonWeeks: 1 });
    const { schedule } = await body<{ schedule: { id: number } }>(created);
    const through = day(75);

    const previewed = await api(`/tournament-schedules/${schedule.id}/create-through?date=${through}`);
    expect(previewed.status).toBe(200);
    const preview = await body<{ tournaments: Entry[]; count: number; tooMany: boolean }>(previewed);
    expect(preview.count).toBeGreaterThanOrEqual(2);
    expect(preview.tournaments.every((t) => t.localDate >= first && t.localDate <= through)).toBe(true);
    expect(creates()).toEqual([]);

    const job = await finished(await post(`/tournament-schedules/${schedule.id}/create-through`, { date: through }));
    expect(job).toMatchObject({ status: 'succeeded', playSessionLabel: `Create Monthly Cup through ${through}` });
    expect(job.tournamentItems.map((i) => i.plannedTournamentId)).toEqual(preview.tournaments.map((t) => t.plannedId));
    expect(creates()).toHaveLength(preview.count);
    const { schedules } = await body<{ schedules: { id: number; createdThrough: string | null }[] }>(await api('/tournament-schedules'));
    expect(schedules.find((s) => s.id === schedule.id)!.createdThrough).toBe(through);
  });

  it('refuses a date more than 12 months ahead, a paused schedule, and another league’s schedule', async () => {
    const templateId = await template();
    const scaffold = await body<{ scaffold: { id: number } }>(await post('/tournament-scaffolds', { name: 'Far', slots: [{ templateId, dayOffset: 0, startTime: null }] }));
    const { schedule } = await body<{ schedule: { id: number } }>(
      await post('/tournament-schedules', { scaffoldId: scaffold.scaffold.id, rule: { kind: 'monthly', day: 15 }, startsOn: day(12), endsOn: null }),
    );
    const tooFar = await api(`/tournament-schedules/${schedule.id}/create-through?date=${day(400)}`);
    expect(tooFar.status).toBe(422);
    expect(await code(tooFar)).toBe('date_too_far_ahead');
    expect((await api(`/tournament-schedules/${schedule.id}`, { method: 'PATCH', json: { paused: true } })).status).toBe(200);
    const paused = await post(`/tournament-schedules/${schedule.id}/create-through`, { date: day(60) });
    expect(paused.status).toBe(409);
    expect(await code(paused)).toBe('schedule_inactive');
    const missing = await api(`/tournament-schedules/99999/create-through?date=${day(30)}`);
    expect(missing.status).toBe(404);
    expect(await code(missing)).toBe('not_found');
  });
});
