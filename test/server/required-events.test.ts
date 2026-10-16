import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakePokemon, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, startServer } from './harness';
import { leagueDay } from './league-day';

// Required events over HTTP (#95, ADR-0010 decision 12): requirements, manual covers and coverage, against the built
// app and the in-process play-tools fake. The server runs on the real clock: the one tournament here is 40 days
// ahead, inside both the monthly and the quarterly grid whatever today is, and its period is found by date, not by
// position, so a midnight during the run can't change an outcome. Date edges live in the unit tests.

const OWNER = { username: 'organizer', password: 'correct horse' };
const TZ = 'America/Chicago';

let fake: FakePokemon;
let server: TestServer;
let browser: ReturnType<typeof client>;
const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
const body = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const code = async (res: Response) => (await body<{ data?: { code?: string } }>(res)).data?.code;
const playToolsCalls = () => fake.requests.filter((r) => r.path.startsWith('/services/core/'));
const activityCalls = () => fake.requests.filter((r) => r.path === '/services/core/activities');

interface Requirement {
  id: number;
  seriesMatch: string;
  product: string;
  cadence: string;
  minCount: number;
  warnDays: number;
  active: boolean;
}
interface Period {
  periodStart: string;
  periodEnd: string;
  status: string;
  bestKnown: string | null;
  tournaments: { tournamentId: string | null }[];
}
interface Coverage {
  upstream: string;
  unread: { professor: { playerId: string | null }; code: string }[];
  requirements: { requirement: Requirement; periods: Period[] }[];
}

const requirements = async () => (await body<{ requirements: Requirement[] }>(await api('/tournament-requirements'))).requirements;
const coverage = async (query = '') => body<Coverage>(await api(`/tournaments/requirements${query}`));

beforeAll(async () => {
  fake = await startFakePokemon();
  server = await startServer({ env: { ...fake.env, TZ } });
  browser = client(server.url);
  const setup = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } });
  expect(setup.status).toBe(200);
  const start = await api('/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL((await body<{ authorizeUrl: string }>(start)).authorizeUrl).searchParams.get('state');
  expect((await api('/pokemon/connect/complete', { method: 'POST', json: { url: `https://play-tools.pokemon.com/loggedIn?code=fresh&state=${state}` } })).status).toBe(200);
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
    ['GET', '/api/tournaments/requirements'],
    ['GET', '/api/tournament-requirements'],
    ['POST', '/api/tournament-requirements'],
    ['PATCH', '/api/tournament-requirements/1'],
    ['PUT', '/api/tournament-requirements/1/covers/2026-10-01'],
    ['DELETE', '/api/tournament-requirements/1/covers/2026-10-01'],
  ])('%s %s is 401 without a session, before validation or any upstream call', async (method, path) => {
    const res = await client(server.url).request(path, { method, json: ['POST', 'PATCH', 'PUT'].includes(method) ? {} : undefined });
    expect(res.status).toBe(401);
    expect(playToolsCalls()).toEqual([]);
  });
});

describe('league clock', () => {
  // The Tournaments page reads the league's zone and date from settings so it never waits on play-tools (#191).
  it("GET /settings gives the server's zone and today's date there, without asking play-tools", async () => {
    const before = leagueDay(0, TZ);
    const res = await api('/settings');
    const after = leagueDay(0, TZ);

    expect(res.status).toBe(200);
    const settings = await body<{ league: { timeZone: string; today: string } }>(res);
    expect(Object.keys(settings).sort()).toEqual(['league', 'thresholds']);
    expect(settings.league.timeZone).toBe(TZ);
    expect([before, after]).toContain(settings.league.today);
    expect(fake.requests).toEqual([]);
  });
});

describe('requirements', () => {
  it("lists the organizer's six, seeded", async () => {
    const listed = await requirements();
    expect(listed.slice(0, 6).map((r) => [r.seriesMatch, r.product, r.cadence, r.warnDays, r.active])).toEqual([
      ['League Cup', 'tcg', 'quarter', 45, true],
      ['League Cup', 'vg', 'quarter', 45, true],
      ['League Cup', 'pgo', 'quarter', 45, true],
      ['League Challenge', 'tcg', 'month', 21, true],
      ['League Challenge', 'vg', 'month', 21, true],
      ['League Challenge', 'pgo', 'month', 21, true],
    ]);
  });

  it('creates one, edits it, and refuses a duplicate', async () => {
    const created = await api('/tournament-requirements', { method: 'POST', json: { seriesMatch: 'Prerelease', product: 'tcg', cadence: 'quarter', minCount: 10, warnDays: 180 } });
    expect(created.status).toBe(201);
    const { requirement } = await body<{ requirement: Requirement }>(created);
    expect(requirement).toMatchObject({ seriesMatch: 'Prerelease', minCount: 10, warnDays: 180, active: true });

    const patched = await api(`/tournament-requirements/${requirement.id}`, { method: 'PATCH', json: { active: false } });
    expect(patched.status).toBe(200);
    expect((await body<{ requirement: Requirement }>(patched)).requirement.active).toBe(false);

    const duplicate = await api('/tournament-requirements', { method: 'POST', json: { seriesMatch: ' prerelease ', product: 'tcg', cadence: 'quarter' } });
    expect(duplicate.status).toBe(409);
    expect(await code(duplicate)).toBe('requirement_exists');
  });

  it.each([
    ['an empty body', 'POST', '/tournament-requirements', {}],
    ['a missing cadence', 'POST', '/tournament-requirements', { seriesMatch: 'x', product: 'tcg' }],
    ['a 101-character match', 'POST', '/tournament-requirements', { seriesMatch: 'x'.repeat(101), product: 'tcg', cadence: 'month' }],
    ['min count 11', 'POST', '/tournament-requirements', { seriesMatch: 'x', product: 'tcg', cadence: 'month', minCount: 11 }],
    ['warn days 0', 'POST', '/tournament-requirements', { seriesMatch: 'x', product: 'tcg', cadence: 'month', warnDays: 0 }],
    ['min count as text', 'POST', '/tournament-requirements', { seriesMatch: 'x', product: 'tcg', cadence: 'month', minCount: '2' }],
    ['an unknown product', 'POST', '/tournament-requirements', { seriesMatch: 'x', product: 'mtg', cadence: 'month' }],
    ['an empty patch', 'PATCH', '/tournament-requirements/1', {}],
    ['id 0', 'PATCH', '/tournament-requirements/0', { active: true }],
    ['id abc', 'PATCH', '/tournament-requirements/abc', { active: true }],
    ['a 501-character note', 'PUT', '/tournament-requirements/1/covers/2026-10-01', { note: 'x'.repeat(501) }],
    ['a blank note', 'PUT', '/tournament-requirements/1/covers/2026-10-01', { note: '  ' }],
    ['month 13', 'PUT', '/tournament-requirements/1/covers/2026-13-01', { note: 'x' }],
    ['a compact date', 'PUT', '/tournament-requirements/1/covers/20261001', { note: 'x' }],
  ])('answers 400 for %s, with no play-tools call', async (_label, method, path, json) => {
    expect((await api(path, { method, json })).status).toBe(400);
    expect(playToolsCalls()).toEqual([]);
  });

  it('answers 404 for a requirement that does not exist', async () => {
    const res = await api('/tournament-requirements/99999', { method: 'PATCH', json: { active: false } });
    expect(res.status).toBe(404);
    expect(await code(res)).toBe('not_found');
  });
});

describe('manual covers', () => {
  it('records, refuses a mid-quarter start, and removes a cover', async () => {
    const cup = (await requirements())[0]!;
    const put = await api(`/tournament-requirements/${cup.id}/covers/2026-10-01`, { method: 'PUT', json: { note: 'Run by Prof Oak, 26-10-000123' } });
    expect(put.status).toBe(200);
    expect((await body<{ cover: unknown }>(put)).cover).toEqual({ periodStart: '2026-10-01', note: 'Run by Prof Oak, 26-10-000123', createdBy: 'organizer', createdAt: expect.any(String) });

    const midQuarter = await api(`/tournament-requirements/${cup.id}/covers/2026-11-01`, { method: 'PUT', json: { note: 'x' } });
    expect(midQuarter.status).toBe(400);
    expect(await code(midQuarter)).toBe('invalid_period');

    const changeCadence = await api(`/tournament-requirements/${cup.id}`, { method: 'PATCH', json: { cadence: 'month' } });
    expect(changeCadence.status).toBe(409);
    expect(await code(changeCadence)).toBe('requirement_has_covers');

    expect((await api(`/tournament-requirements/${cup.id}/covers/2026-10-01`, { method: 'DELETE' })).status).toBe(204);
    const again = await api(`/tournament-requirements/${cup.id}/covers/2026-10-01`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(await code(again)).toBe('not_found');
  });
});

describe('coverage', () => {
  /** The league's date 40 days from now, and the TCG League Challenge's period holding it. */
  const ahead = () => leagueDay(40, TZ);
  const tcgChallenge = (c: Coverage) => c.requirements.find((r) => r.requirement.product === 'tcg' && r.requirement.seriesMatch === 'League Challenge')!;
  const holding = (c: Coverage, date: string) => tcgChallenge(c).periods.find((p) => p.periodStart <= date && date <= p.periodEnd)!;

  it("counts a sanctioned League Challenge in its period, with its series from play-tools' details", async () => {
    const date = ahead();
    fake.tournaments = [{ ...fakeTournament('lc-1', { startsAt: `${date}T23:00:00Z` }), series: { guid: '00000000-0000-4000-8000-0000000000c1', name: 'League Challenge' } }];

    const result = await coverage('?refresh=1');

    expect(result.upstream).toBe('read');
    expect(holding(result, date)).toMatchObject({ status: 'sanctioned', tournaments: [{ tournamentId: 'lc-1' }] });
  });

  it("answers 200 when play-tools can't list, and never says missing", async () => {
    fake.failOnce.set('/services/core/activities', 503);

    const res = await api('/tournaments/requirements?refresh=1');

    expect(res.status).toBe(200);
    const result = await body<Coverage>(res);
    expect(result.unread).toEqual([expect.objectContaining({ code: 'upstream_unavailable' })]);
    const statuses = result.requirements.flatMap((r) => r.periods.map((p) => p.status));
    expect(statuses).not.toContain('missing');
  });

  it('reuses the listing on the next read, reads activities again on refresh, and refuses any other refresh', async () => {
    await coverage('?refresh=1');
    fake.requests.length = 0;
    await coverage();
    expect(activityCalls()).toEqual([]);
    await coverage('?refresh=1');
    expect(activityCalls().length).toBeGreaterThan(0);
    const bad = await api('/tournaments/requirements?refresh=yes');
    expect(bad.status).toBe(400);
  });
});
