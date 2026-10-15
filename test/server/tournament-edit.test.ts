import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localInstant } from '../../shared/time/local-time';
import { FAKE_PLAYER_ID, FAKE_VENUE, type FakePokemon, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';
import { leagueDay } from './league-day';

// Editing and rescheduling tournaments (#93) over HTTP, against the built app and the play-tools fake: the three
// routes, the tournament_edit job, and what reaches play-tools: a PATCH with only the changed wire fields. The server
// runs on the real clock, so dates sit 10 or more days from a window edge, except where a reschedule needs to be near.
// Timing rules (pacing, midnight, the 5xx re-read) are the module tests', on a fake clock.

const OWNER = { username: 'organizer', password: 'correct horse' };
const TZ = 'America/Chicago';
const ENV = { TZ, NUXT_TOURNAMENT_DELAY_MS: '0', NUXT_LOG_FORMAT: 'json' };
const GUID = '00000000-0000-4000-8000-0000000000e1';

const day = (days: number) => leagueDay(days, TZ);
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
const at18 = (date: string) => localInstant(date, '18:00', TZ).toISOString().replace('.000', '');

let fake: FakePokemon;
let server: TestServer;
let browser: ReturnType<typeof client>;
const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
const post = (path: string, json: unknown) => api(path, { method: 'POST', json });
const body = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const code = async (res: Response) => (await body<{ data?: { code?: string } }>(res)).data?.code;
const patches = () => fake.requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/services/core/tournament/'));
const writes = () => fake.requests.filter((r) => r.method !== 'GET');

interface Job {
  status: string;
  kind: string;
  playSessionLabel: string;
  tournamentItems: { outcome: string; plannedTournamentId: number | null; tournamentId: string | null }[];
}

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

let serial = 0;
async function template(): Promise<number> {
  const res = await post('/tournament-templates', {
    name: `Tuesday Cup ${++serial}`,
    organizerPlayerId: FAKE_PLAYER_ID,
    product: 'tcg',
    category: 'tcg_std',
    type: { kind: 'custom' },
    venue: { id: FAKE_VENUE.guid, label: 'Card Shop', timeZone: TZ, country: 'US' },
    startTime: '18:00',
    registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: null },
    contactEmail: 'league@example.com',
    details: 'Bring a deck.',
  });
  expect(res.status).toBe(201);
  return (await body<{ template: { id: number } }>(res)).template.id;
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
  // No token, and no request body (the PATCH's wire fields), in the logs.
  expect(server.logs()).not.toMatch(/ory_rt_|eyJ|start_date_v2|contact_information/);
  await server.dispose();
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.tournaments = [];
});

describe('auth and validation', () => {
  it.each([
    ['GET', `/api/tournaments/${GUID}/edit`],
    ['POST', `/api/tournaments/${GUID}/edit/preview`],
    ['POST', `/api/tournaments/${GUID}/edit`],
  ])('%s %s is 401 without a session, before validation or any upstream call', async (method, path) => {
    const res = await fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    expect(res.status).toBe(401);
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ['GET', '/tournaments/not-an-id/edit', undefined],
    ['POST', `/tournaments/${GUID}/edit/preview`, { changes: {} }],
    ['POST', `/tournaments/${GUID}/edit/preview`, { changes: { product: 'vg' } }],
    ['POST', `/tournaments/${GUID}/edit/preview`, { changes: { name: 'X' }, fields: ['localDate'] }],
    ['POST', `/tournaments/${GUID}/edit`, { changes: { localDate: '2026-02-30' } }],
    ['POST', `/tournaments/${GUID}/edit`, { changes: { name: 'X' }, excluded: Array.from({ length: 201 }, (_, i) => `p:${i + 1}`) }],
  ])('%s %s %j is 400', async (method, path, json) => {
    const res = await api(path, { method, ...(json !== undefined && { json }) });
    expect(res.status).toBe(400);
    expect(fake.requests).toEqual([]);
  });
});

describe('a tournament made in play-tools', () => {
  beforeEach(() => {
    fake.tournaments = [{ ...fakeTournament(GUID, { startsAt: at18(day(20)), name: 'Friday Cup' }), details: 'Bring a deck.' }];
  });

  it('shows the form from a fresh read, with the read-only fields and the reschedule window', async () => {
    const res = await api(`/tournaments/${GUID}/edit`);
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      target: { plannedId: null, tournamentId: GUID, inPlayTools: true },
      values: { name: 'Friday Cup', localDate: day(20), startTime: '18:00', details: 'Bring a deck.', contactEmail: 'league@example.com' },
      readOnly: { organizer: { playerId: FAKE_PLAYER_ID }, product: 'tcg', type: { kind: 'custom' } },
      reschedule: { opensOn: day(17), open: false },
      schedule: null,
    });
    expect(writes()).toEqual([]);
  });

  it('sends a PATCH with only the changed wire fields', async () => {
    const preview = await post(`/tournaments/${GUID}/edit/preview`, { changes: { name: 'Friday Cup Deluxe', details: 'Bring a deck.', eventWebsite: 'https://example.com/cup' } });
    expect(preview.status).toBe(200);
    expect(await body(preview)).toMatchObject({ reschedule: false, count: 1, inPlayTools: [{ changes: [{ field: 'name' }, { field: 'eventWebsite' }] }] });
    expect(writes()).toEqual([]);

    const job = await finished(await post(`/tournaments/${GUID}/edit`, { changes: { name: 'Friday Cup Deluxe', details: 'Bring a deck.', eventWebsite: 'https://example.com/cup' } }));

    expect(job).toMatchObject({ kind: 'tournament_edit', status: 'succeeded', playSessionLabel: `Edit Friday Cup · ${day(20)}`, tournamentItems: [{ outcome: 'edited' }] });
    expect(patches().map((p) => p.body)).toEqual([{ name: 'Friday Cup Deluxe', event_website: 'https://example.com/cup' }]);
  });

  it.each([
    ['a date change outside the reschedule window', { localDate: day(21) }, 'reschedule_window_not_open'],
    ['nothing new', { name: 'Friday Cup' }, 'nothing_to_change'],
    ['a scope off a schedule', { name: 'X' }, 'not_in_schedule'],
  ])('refuses %s with 422', async (_what, changes, expected) => {
    const extra = expected === 'not_in_schedule' ? { scope: 'later' } : {};
    for (const path of [`/tournaments/${GUID}/edit/preview`, `/tournaments/${GUID}/edit`]) {
      const res = await post(path, { changes, ...extra });
      expect(res.status).toBe(422);
      expect(await code(res)).toBe(expected);
    }
    expect(writes()).toEqual([]);
  });

  it('is 404 for a tournament nobody connected can read', async () => {
    const res = await api('/tournaments/00000000-0000-4000-8000-0000000000ff/edit');
    expect(res.status).toBe(404);
  });
});

describe('across a schedule', () => {
  it('edits the created ones later in the schedule, and updates the planned ones locally', async () => {
    const first = day(14);
    const t = await template();
    const scaffold = await body<{ scaffold: { id: number } }>(await post('/tournament-scaffolds', { name: 'Tuesdays', slots: [{ templateId: t, dayOffset: 0 }] }));
    const created = await post('/tournament-schedules', {
      scaffoldId: scaffold.scaffold.id,
      rule: { kind: 'weekly', weekday: weekdayOf(first), every: 1 },
      startsOn: first,
      endsOn: null,
      horizonWeeks: 6,
    });
    expect(created.status).toBe(201);
    const { tournaments } = await body<{ tournaments: { plannedId: number; localDate: string }[] }>(await api('/tournaments/upcoming'));
    const rows = tournaments.filter((x) => x.plannedId !== null && x.localDate >= first);
    const create = await finished(await post('/tournaments/create', { plannedIds: rows.slice(0, 2).map((r) => r.plannedId) }));
    expect(create.tournamentItems.map((i) => i.outcome)).toEqual(['created', 'created']);
    fake.requests.length = 0;

    const edit = await post(`/tournaments/${rows[0]!.plannedId}/edit`, { changes: { details: 'Now at the library.' }, scope: 'later' });
    const { updatedLocally } = (await edit.clone().json()) as { updatedLocally: number };
    const job = await finished(edit);

    expect(job.tournamentItems.map((i) => [i.plannedTournamentId, i.outcome])).toEqual([
      [rows[0]!.plannedId, 'edited'],
      [rows[1]!.plannedId, 'edited'],
    ]);
    expect(patches().map((p) => p.body)).toEqual([{ details: 'Now at the library.' }, { details: 'Now at the library.' }]);
    expect(updatedLocally).toBe(rows.length - 2);
    const later = await body<{ values: { details: string } }>(await api(`/tournaments/${rows.at(-1)!.plannedId}/edit`));
    expect(later.values.details).toBe('Now at the library.');
  });
});

describe('rescheduling', () => {
  it('moves the tournament in place, with its staff', async () => {
    const from = day(2);
    const to = day(3);
    fake.tournaments = [fakeTournament(GUID, { startsAt: at18(from), name: 'Friday Cup' })];
    const staffed = await post(`/sessions/${from}/staff`, { tournamentId: GUID, playerId: '00123', role: 'judge', name: 'Ash Ketchum' });
    expect(staffed.status).toBe(201);

    const unacknowledged = await post(`/tournaments/${GUID}/edit`, { changes: { localDate: to } });
    expect(unacknowledged.status).toBe(422);
    expect(await code(unacknowledged)).toBe('short_notice_not_acknowledged');

    const job = await finished(await post(`/tournaments/${GUID}/edit`, { changes: { localDate: to }, acknowledgeShortNotice: true }));

    expect(job).toMatchObject({ status: 'succeeded', playSessionLabel: `Reschedule Friday Cup · ${from}` });
    expect(patches().map((p) => p.body)).toEqual([{ start_date_v2: at18(to) }]);
    const staff = await body<{ tournaments: { tournamentId: string; assignments: { playerId: string }[] }[] }>(await api(`/sessions/${to}/staff`));
    expect(staff.tournaments.find((x) => x.tournamentId === GUID)?.assignments.map((a) => a.playerId)).toEqual(['00123']);
  });
});
