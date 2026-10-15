import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PLAYER_ID, FAKE_VENUE, type FakePokemon, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';
import { leagueDay } from './league-day';

// The tournaments module over HTTP (#91): templates, scaffolds, schedules, planned tournaments and Upcoming,
// against the built app and the in-process play-tools fake. The server runs on the real clock, so every date
// here is 10 or more days from an edge of the creatable window (today − 2 days … 12 months ahead): a midnight
// during the run can't change an outcome. Edge cases live in the module tests, which have a fixed clock.

const OWNER = { username: 'organizer', password: 'correct horse' };
const TZ = 'America/Chicago';

/** The league's date `days` from today. */
const day = (days: number) => leagueDay(days, TZ);

let fake: FakePokemon;
let server: TestServer;
let browser: ReturnType<typeof client>;
const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
const post = (path: string, json: unknown) => api(path, { method: 'POST', json });
const patch = (path: string, json: unknown) => api(path, { method: 'PATCH', json });
const body = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const code = async (res: Response) => (await body<{ data?: { code?: string } }>(res)).data?.code;
/** Calls the app made to play-tools' API (not the login). */
const playToolsCalls = () => fake.requests.filter((r) => r.path.startsWith('/services/core/'));

const TEMPLATE = {
  name: 'Friday Cup {month}',
  organizerPlayerId: FAKE_PLAYER_ID,
  product: 'tcg',
  category: 'tcg_std',
  type: { kind: 'custom' },
  venue: { id: FAKE_VENUE.guid, label: 'Card Shop', timeZone: TZ, country: 'US' },
  startTime: '18:00',
  registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: null },
  contactEmail: 'league@example.com',
};

beforeAll(async () => {
  fake = await startFakePokemon();
  server = await startServer({ env: { ...fake.env, TZ } });
  browser = client(server.url);
  const setup = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } });
  expect(setup.status).toBe(200);
  const start = await post('/pokemon/connect/start', {});
  const state = new URL((await body<{ authorizeUrl: string }>(start)).authorizeUrl).searchParams.get('state');
  expect((await post('/pokemon/connect/complete', { url: `https://play-tools.pokemon.com/loggedIn?code=fresh&state=${state}` })).status).toBe(200);
});
afterAll(async () => {
  expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
  await server.dispose();
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.tournaments = [];
  fake.series = [];
});

describe('auth', () => {
  it.each([
    ['GET', '/api/tournament-templates'],
    ['POST', '/api/tournament-templates'],
    ['PATCH', '/api/tournament-templates/1'],
    ['DELETE', '/api/tournament-templates/1'],
    ['GET', `/api/tournament-templates/options?professor=${FAKE_PLAYER_ID}`],
    ['GET', '/api/tournament-scaffolds'],
    ['POST', '/api/tournament-scaffolds'],
    ['PATCH', '/api/tournament-scaffolds/1'],
    ['DELETE', '/api/tournament-scaffolds/1'],
    ['GET', '/api/tournament-schedules'],
    ['POST', '/api/tournament-schedules'],
    ['POST', '/api/tournament-schedules/preview'],
    ['PATCH', '/api/tournament-schedules/1'],
    ['DELETE', '/api/tournament-schedules/1'],
    ['POST', '/api/planned-tournaments'],
    ['PATCH', '/api/planned-tournaments/1'],
    ['GET', '/api/tournaments/upcoming'],
    ['GET', '/api/tournaments/upcoming?refresh=1'],
  ])('%s %s is 401 without a session, before validation or any upstream call', async (method, path) => {
    const res = await client(server.url).request(path, { method, json: ['POST', 'PATCH'].includes(method) ? {} : undefined });
    expect(res.status).toBe(401);
    expect(playToolsCalls()).toEqual([]);
  });
});

describe('templates', () => {
  it('creates, lists, patches and archives one', async () => {
    const created = await post('/tournament-templates', TEMPLATE);
    expect(created.status).toBe(201);
    const { template } = await body<{ template: { id: number; details: string | null } }>(created);
    expect(template).toMatchObject({ ...TEMPLATE, contactPhone: null, details: null, eventWebsite: null, archived: false });

    const patched = await patch(`/tournament-templates/${template.id}`, { details: 'Doors at 5.' });
    expect(patched.status).toBe(200);
    expect((await body<{ template: { details: string } }>(patched)).template.details).toBe('Doors at 5.');

    expect((await api(`/tournament-templates/${template.id}`, { method: 'DELETE' })).status).toBe(204);
    const listed = await body<{ templates: { id: number }[] }>(await api('/tournament-templates'));
    expect(listed.templates.some((t) => t.id === template.id)).toBe(false);
    const archived = await body<{ templates: { id: number; archived: boolean }[] }>(await api('/tournament-templates?archived=1'));
    expect(archived.templates.find((t) => t.id === template.id)?.archived).toBe(true);
  });

  it.each([
    ['an 81-character name', { name: 'x'.repeat(81) }],
    ['no contact', { contactEmail: null }],
    ['an http website', { eventWebsite: 'http://example.com' }],
    ['a field the template lacks', { colour: 'red' }],
  ])('is 400 for %s', async (_, change) => {
    expect((await post('/tournament-templates', { ...TEMPLATE, ...change })).status).toBe(400);
  });

  it('is 422 organizer_not_connected for a professor who isn’t connected, 400 for an empty patch, 404 for an unknown id', async () => {
    const res = await post('/tournament-templates', { ...TEMPLATE, organizerPlayerId: '1234567' });
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('organizer_not_connected');
    expect((await patch('/tournament-templates/1', {})).status).toBe(400);
    expect((await patch('/tournament-templates/999999', { details: 'x' })).status).toBe(404);
    expect((await patch('/tournament-templates/abc', { details: 'x' })).status).toBe(400);
  });
});

describe('live form options', () => {
  it('reads the types for a date, formats and venues as the professor', async () => {
    const date = day(30);
    fake.series = [
      { guid: 'lc-now', name: 'League Challenge', product: 'tcg', category_slugs: ['tcg_std'], tags: [], play_template: null, schedule: { US: { start_date: day(20), end_date: day(40) } } },
      { guid: 'lc-later', name: 'League Challenge', product: 'tcg', category_slugs: ['tcg_std'], tags: [], play_template: null, schedule: { US: { start_date: day(60), end_date: day(90) } } },
    ];
    const res = await api(`/tournament-templates/options?professor=${FAKE_PLAYER_ID}&date=${date}`);
    expect(res.status).toBe(200);
    const options = await body<{ types: { kind: string; seriesId?: string }[]; formats: unknown[]; venues: { id: string }[] }>(res);
    expect(options.types.map((t) => t.seriesId ?? t.kind)).toEqual(['custom', 'lc-now']);
    expect(options.formats.length).toBeGreaterThan(0);
    expect(options.venues.map((v) => v.id)).toContain(FAKE_VENUE.guid);
    expect(playToolsCalls().every((r) => r.method === 'GET')).toBe(true);
  });

  it('is 400 without a professor, 404 connection_not_found for one who isn’t connected', async () => {
    expect((await api('/tournament-templates/options')).status).toBe(400);
    const res = await api('/tournament-templates/options?professor=1234567');
    expect(res.status).toBe(404);
    expect(await code(res)).toBe('connection_not_found');
  });
});

describe('Upcoming’s listing cache (#98)', () => {
  const listings = () => playToolsCalls().filter((r) => r.path === '/services/core/activities');

  it('reuses the listing on a second read, and lists again on refresh=1', async () => {
    expect((await api('/tournaments/upcoming?refresh=1')).status).toBe(200);
    fake.requests.length = 0;
    fake.tournaments = [fakeTournament('late-cup', { startsAt: `${day(15)}T23:00:00Z`, organizer: FAKE_PLAYER_ID, name: 'Late Cup' })];

    const cached = await body<{ tournaments: { tournamentId: string | null }[] }>(await api('/tournaments/upcoming'));
    expect(listings()).toEqual([]);
    expect(cached.tournaments.map((t) => t.tournamentId)).not.toContain('late-cup');

    const fresh = await body<{ tournaments: { tournamentId: string | null }[] }>(await api('/tournaments/upcoming?refresh=1'));
    expect(listings()).toHaveLength(1);
    expect(fresh.tournaments.map((t) => t.tournamentId)).toContain('late-cup');
  });

  it.each(['yes', '', 'true', '1&refresh=1'])('refuses refresh=%j with 400, before any upstream call', async (value) => {
    const res = await api(`/tournaments/upcoming?refresh=${value}`);
    expect(res.status).toBe(400);
    expect(playToolsCalls()).toEqual([]);
  });
});

describe('scaffolds, schedules, planned tournaments and Upcoming', () => {
  async function newTemplate(name: string) {
    return (await body<{ template: { id: number } }>(await post('/tournament-templates', { ...TEMPLATE, name }))).template.id;
  }

  it('plans a schedule on read and lists it with the league’s play-tools tournaments, only reading play-tools', async () => {
    const templateId = await newTemplate('Weekly Cup');
    const scaffold = await post('/tournament-scaffolds', { name: 'Weekly', slots: [{ templateId, dayOffset: 0, startTime: '17:00' }] });
    expect(scaffold.status).toBe(201);
    const { scaffold: s } = await body<{ scaffold: { id: number } }>(scaffold);

    // Weekly on today's weekday + 10 days, from then on.
    const first = day(10);
    const weekday = ((new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const created = await post('/tournament-schedules', { scaffoldId: s.id, rule: { kind: 'weekly', weekday, every: 1 }, startsOn: first, endsOn: null });
    expect(created.status).toBe(201);
    const { schedule } = await body<{ schedule: { id: number; horizonWeeks: number } }>(created);
    expect(schedule.horizonWeeks).toBe(8);

    fake.tournaments = [
      fakeTournament('in-league', { startsAt: `${day(15)}T23:00:00Z`, organizer: FAKE_PLAYER_ID, name: 'Hand-made Cup' }),
      fakeTournament('elsewhere', { startsAt: `${day(15)}T23:00:00Z`, organizer: FAKE_PLAYER_ID, groupId: 'another-store' }),
    ];
    // play-tools changed outside the app, so read it again rather than the 5-minute listing cache (#98).
    const res = await api('/tournaments/upcoming?refresh=1');
    expect(res.status).toBe(200);
    const upcoming = await body<{ upstream: string; tournaments: { state: string; localDate: string; tournamentId: string | null; name: string; actions: string[] }[] }>(res);
    expect(upcoming.upstream).toBe('read');
    const planned = upcoming.tournaments.filter((t) => t.state === 'planned');
    // Today + 10 through today + 56: seven weekly dates.
    expect(planned.map((t) => t.localDate)).toEqual([10, 17, 24, 31, 38, 45, 52].map(day));
    expect(planned[0]).toMatchObject({ name: expect.stringMatching(/^Weekly Cup$/), actions: ['create', 'skip'] });
    expect(upcoming.tournaments.filter((t) => t.state === 'upstream').map((t) => t.tournamentId)).toEqual(['in-league']);

    expect(playToolsCalls().every((r) => r.method === 'GET')).toBe(true);
    // One listing for the one connected professor.
    expect(playToolsCalls().filter((r) => r.path === '/services/core/activities')).toHaveLength(1);

    // A second read plans nothing new.
    const again = await body<{ tournaments: { state: string }[] }>(await api('/tournaments/upcoming'));
    expect(again.tournaments.filter((t) => t.state === 'planned')).toHaveLength(7);

    // Skipping one is local.
    const firstPlanned = (await body<{ tournaments: { plannedId: number; state: string }[] }>(await api('/tournaments/upcoming'))).tournaments.find((t) => t.state === 'planned')!;
    fake.requests.length = 0;
    const skipped = await patch(`/planned-tournaments/${firstPlanned.plannedId}`, { skipped: true });
    expect(skipped.status).toBe(200);
    expect((await body<{ planned: { state: string } }>(skipped)).planned.state).toBe('skipped');
    expect(playToolsCalls()).toEqual([]);

    expect((await api(`/tournament-scaffolds/${s.id}`, { method: 'DELETE' })).status).toBe(409);
    expect((await api(`/tournament-schedules/${schedule.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await api(`/tournament-scaffolds/${s.id}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('plans a one-off, refusing the same event twice and a date too far back', async () => {
    const templateId = await newTemplate('One-off Cup');
    const date = day(20);
    const first = await post('/planned-tournaments', { templateId, localDate: date });
    expect(first.status).toBe(201);
    const { planned } = await body<{ planned: { plannedId: number; startTime: string; sanctionBy: string } }>(first);
    expect(planned).toMatchObject({ startTime: '18:00', sanctionBy: day(13) });

    const again = await post('/planned-tournaments', { templateId, localDate: date, startTime: '18:00' });
    expect(again.status).toBe(409);
    expect(await body(again)).toMatchObject({ data: { code: 'already_planned', plannedTournamentId: planned.plannedId } });

    const old = await post('/planned-tournaments', { templateId, localDate: day(-30) });
    expect(old.status).toBe(422);
    expect(await code(old)).toBe('date_too_far_past');

    const moved = await patch(`/planned-tournaments/${planned.plannedId}`, { localDate: day(21) });
    expect(moved.status).toBe(200);
    expect(await body(moved)).toMatchObject({ planned: { localDate: day(21) }, warnings: [] });
  });

  it('refuses a scaffold of an unknown template, a schedule ending before it starts, and a bad range', async () => {
    const res = await post('/tournament-scaffolds', { name: 'Bad', slots: [{ templateId: 999999, dayOffset: 0, startTime: null }] });
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('unknown_template');
    expect((await post('/tournament-schedules', { scaffoldId: 1, rule: { kind: 'monthly', day: 3 }, startsOn: day(20), endsOn: day(10) })).status).toBe(400);
    expect((await api(`/tournaments/upcoming?from=${day(20)}&to=${day(10)}`)).status).toBe(400);
  });

  it('previews a schedule’s next dates without saving it', async () => {
    const before = await body<{ schedules: unknown[] }>(await api('/tournament-schedules'));
    const res = await post('/tournament-schedules/preview', { rule: { kind: 'monthly', day: 1 }, startsOn: day(-400), count: 3 });
    expect(res.status).toBe(200);
    expect((await body<{ dates: unknown[] }>(res)).dates).toHaveLength(3);
    expect((await body<{ schedules: unknown[] }>(await api('/tournament-schedules'))).schedules).toHaveLength(before.schedules.length);
  });
});
