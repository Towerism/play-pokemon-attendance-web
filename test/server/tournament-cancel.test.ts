import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localInstant } from '../../shared/time/local-time';
import { FAKE_PLAYER_ID, FAKE_VENUE, type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';

// Cancelling a tournament (#94) over HTTP, against the built app and the play-tools fake: the confirm preview, the
// typed confirmation, the tournament_cancel job, and what reaches play-tools: exactly one PATCH
// `{application_state: "cancelled"}` to the tournament named. Dates sit 20 days out, far from any window edge; the
// job's timing rules (pacing, the 5xx re-read, recovery) are the module tests', on a fake clock.

const OWNER = { username: 'organizer', password: 'correct horse' };
const TZ = 'America/Chicago';
const DAY = 86_400_000;
const ENV = { TZ, NUXT_TOURNAMENT_DELAY_MS: '0', NUXT_LOG_FORMAT: 'json' };
const GUID = '00000000-0000-4000-8000-0000000000c1';
const DISPLAY_ID = '26-10-900001';

const day = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() + days * DAY));
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
  counts: { added: number };
  tournamentItems: { outcome: string; tournamentId: string | null }[];
}

async function finished(res: Response): Promise<Job & { id: number }> {
  expect(res.status).toBe(202);
  const { submissionId } = await body<{ submissionId: number }>(res);
  for (const deadline = Date.now() + 25_000; Date.now() < deadline; ) {
    const job = await body<Job>(await api(`/submissions/${submissionId}`));
    if (job.status !== 'planned' && job.status !== 'running') return { ...job, id: submissionId };
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
  // No token, no request body, and no registered player's name or id in the logs.
  expect(server.logs()).not.toMatch(/ory_rt_|eyJ|application_state|Ketchum|00123/);
  await server.dispose();
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  fake.tournaments = [];
  fake.tournamentRecords.clear();
});

describe('auth and validation', () => {
  it.each([
    ['GET', `/api/tournaments/${GUID}/cancel`],
    ['POST', `/api/tournaments/${GUID}/cancel`],
  ])('%s %s is 401 without a session, before validation or any upstream call', async (method, path) => {
    const res = await fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    expect(res.status).toBe(401);
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ['GET', '/tournaments/not-an-id/cancel', undefined],
    ['POST', `/tournaments/${GUID}/cancel`, { confirmDisplayId: DISPLAY_ID }],
    ['POST', `/tournaments/${GUID}/cancel`, { confirmation: 261000001 }],
    ['POST', `/tournaments/${GUID}/cancel`, { confirmation: 'x'.repeat(33) }],
  ])('%s %s %j is 400', async (method, path, json) => {
    const res = await api(path, { method, ...(json !== undefined && { json }) });
    expect(res.status).toBe(400);
    expect(fake.requests).toEqual([]);
  });
});

describe('a tournament in play-tools with players registered', () => {
  beforeEach(() => {
    fake.tournaments = [fakeTournament(GUID, { startsAt: at18(day(20)), name: 'Friday Cup', displayId: DISPLAY_ID })];
    fake.tournamentRecords.set(GUID, [
      fakeRecord(FAKE_PLAYER_ID, { role: 'organizer' }),
      fakeRecord('00123', { first: 'Ash', last: 'Ketchum' }),
      fakeRecord('00456', { role: 'judge', first: 'Misty', last: 'Waterflower' }),
    ]);
  });

  it('previews it from fresh reads, with counts only, and asks for its display id', async () => {
    const res = await api(`/tournaments/${GUID}/cancel`);
    expect(res.status).toBe(200);
    const preview = await body(res);
    expect(preview).toEqual({
      target: { plannedId: null, tournamentId: GUID, displayId: DISPLAY_ID },
      name: 'Friday Cup',
      localDate: day(20),
      startTime: '18:00',
      organizer: { playerId: FAKE_PLAYER_ID, name: 'Olive Organizer' },
      upstreamStatus: 'sanctioned',
      players: 1,
      staff: 1,
      cancellable: true,
      reason: null,
      closesOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      confirmRequired: true,
      confirmWith: DISPLAY_ID,
    });
    expect(JSON.stringify(preview)).not.toMatch(/00123|00456|Ketchum|Misty/);
    expect(writes()).toEqual([]);
  });

  it('refuses a wrong confirmation, then cancels with the right one: one PATCH, to that tournament, with only the state', async () => {
    const wrong = await post(`/tournaments/${GUID}/cancel`, { confirmation: day(20) });
    expect(wrong.status).toBe(422);
    expect(await body(wrong)).toMatchObject({ data: { code: 'confirmation_mismatch', required: true } });
    expect(writes()).toEqual([]);

    const job = await finished(await post(`/tournaments/${GUID}/cancel`, { confirmation: DISPLAY_ID }));

    expect(job).toMatchObject({
      kind: 'tournament_cancel',
      status: 'succeeded',
      playSessionLabel: `Cancel Friday Cup · ${day(20)}`,
      counts: { added: 1 },
      tournamentItems: [{ outcome: 'cancelled', tournamentId: GUID }],
    });
    expect(patches().map((p) => [p.path, p.body])).toEqual([[`/services/core/tournament/${GUID}/`, { application_state: 'cancelled' }]]);
    expect(writes()).toHaveLength(1);
    const history = await body<{ submissions: { id: number; kind: string }[] }>(await api('/submissions'));
    expect(history.submissions.find((s) => s.id === job.id)).toMatchObject({ kind: 'tournament_cancel' });

    const retry = await post(`/submissions/${job.id}/retry`, {});
    expect(retry.status).toBe(422);
    expect(await code(retry)).toBe('nothing_to_cancel');
  });

  it('answers 200 with no job and no PATCH for one play-tools already cancelled', async () => {
    fake.tournaments[0]!.status = 'cancelled';
    fake.tournaments[0]!.application_state = 'cancelled';
    const res = await post(`/tournaments/${GUID}/cancel`, { confirmation: DISPLAY_ID });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ submissionId: null, outcome: 'already_cancelled' });
    expect(writes()).toEqual([]);
  });

  it('refuses a completed tournament as locked, with no PATCH', async () => {
    fake.tournaments = [fakeTournament(GUID, { startsAt: at18(day(-20)), name: 'Friday Cup', status: 'complete', displayId: DISPLAY_ID })];
    const res = await post(`/tournaments/${GUID}/cancel`, { confirmation: DISPLAY_ID });
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('tournament_locked');
    expect(writes()).toEqual([]);
  });
});

describe('planned tournaments', () => {
  it('refuses one that never reached play-tools: Skip is the way, with no upstream call', async () => {
    const template = await post('/tournament-templates', {
      name: 'Tuesday Cup',
      organizerPlayerId: FAKE_PLAYER_ID,
      product: 'tcg',
      category: 'tcg_std',
      type: { kind: 'custom' },
      venue: { id: FAKE_VENUE.guid, label: 'Card Shop', timeZone: TZ, country: 'US' },
      startTime: '18:00',
      registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: null },
      contactEmail: 'league@example.com',
    });
    expect(template.status).toBe(201);
    const templateId = (await body<{ template: { id: number } }>(template)).template.id;
    const planned = await post('/planned-tournaments', { templateId, localDate: day(30) });
    expect(planned.status).toBe(201);
    const plannedId = (await body<{ planned: { plannedId: number } }>(planned)).planned.plannedId;
    fake.requests.length = 0;

    const res = await api(`/tournaments/${plannedId}/cancel`);
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ data: { code: 'not_in_play_tools', state: 'planned' } });
    expect(fake.requests).toEqual([]);
  });
});
