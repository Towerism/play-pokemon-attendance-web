import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PLAYER_ID, type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, startServer } from './harness';

// #76: assign staff for every tournament on a date at once. The fake follows S6:
// each professor lists only their own tournaments, and only the organizer writes
// a tournament's records.

const OWNER = { username: 'organizer', password: 'correct horse' };
// The floor (500 ms) keeps these tests quick without turning pacing off.
const ENV = { TZ: 'America/Chicago', NUXT_STAFF_DELAY_MS: '0' };
const WED = '2026-10-14';
const BROCK = '0000222';

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

/** Staff writes play-tools received, in order: [tournament, as whom]. */
const staffWrites = () =>
  fake.requests
    .filter((r) => r.method !== 'GET' && /\/services\/core\/tournaments\/[^/]+\/records/.test(r.path))
    .map((r) => [r.path.split('/')[4], r.as]);

describe('staff batch API (#76)', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;
  const bodies: string[] = [];

  async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
    const res = await browser.request(`/api${path}`, init);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: () => JSON.parse(text), code: () => (JSON.parse(text) as { data?: { code?: string } }).data?.code };
  }
  const applyAll = (body: unknown, date = WED) => api(`/sessions/${date}/staff/apply-all`, { method: 'POST', json: body });

  async function connectAs(code: string) {
    const start = await api('/pokemon/connect/start', { method: 'POST', json: {} });
    const state = new URL((start.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get('state');
    const res = await api('/pokemon/connect/complete', { method: 'POST', json: { url: `https://play-tools.pokemon.com/loggedIn?code=${code}&state=${state}` } });
    expect(res.status).toBe(200);
  }

  /** Olive and Brock connected in the same league, each wanting one judge on their own tournament. */
  async function twoProfessorsWantingStaff() {
    await connectAs('fresh');
    const brock = fake.addAccount({ playerId: BROCK, name: 'Brock Harrison', leagues: fake.leagues });
    await connectAs(brock.code);
    expect((await api(`/pokemon/connections/${BROCK}`, { method: 'PATCH', json: { name: 'Brock Harrison' } })).status).toBe(200);
    for (const [tournamentId, playerId] of [
      ['brocks', '00777'],
      ['olives', '00999'],
    ]) {
      const res = await api(`/sessions/${WED}/staff`, { method: 'POST', json: { tournamentId, playerId, role: 'judge', name: `Staffer ${playerId}` } });
      expect(res.status).toBe(201);
    }
    fake.requests.length = 0;
  }

  async function finished(batchId: number) {
    for (let i = 0; i < 300; i++) {
      const view = (await api(`/staff-batches/${batchId}`)).json();
      if (view.status !== 'running') return view;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the batch did not finish');
  }

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.accessTtl = 3599;
    fake.accounts.splice(1);
    fake.failOnce.clear();
    fake.lockedTournaments = new Set();
    fake.refuseStaff = new Map();
    fake.staffPostDelayMs = 0;
    fake.leagues = [{ guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true }];
    fake.tournaments = [
      // 17:00 and 18:30 on Wednesday in Chicago.
      fakeTournament('brocks', { startsAt: '2026-10-14T22:00:00Z', organizer: BROCK, name: 'Brock Cup' }),
      fakeTournament('olives', { startsAt: '2026-10-14T23:30:00Z', organizer: FAKE_PLAYER_ID, name: 'Olive Cup' }),
    ];
    fake.tournamentRecords = new Map([
      ['brocks', [fakeRecord(BROCK, { role: 'organizer' })]],
      ['olives', [fakeRecord(FAKE_PLAYER_ID, { role: 'organizer' })]],
    ]);
    bodies.length = 0;
    server = await startServer({ env: { ...fake.env, ...ENV } });
    browser = client(server.url);
    const setup = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } });
    expect(setup.status).toBe(200);
  });

  afterEach(async () => {
    const secrets = fake.issuedTokens();
    for (const text of [...bodies, server.logs()]) for (const s of secrets) expect(text).not.toContain(s);
    expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
    await server.dispose();
  });

  it.each([
    ['POST', `/api/sessions/${WED}/staff/apply-all`],
    ['GET', `/api/sessions/${WED}/staff/apply-all`],
    ['GET', '/api/staff-batches/1'],
  ])('%s %s is 401 without a session, before any upstream call', async (method, path) => {
    const res = await client(server.url).request(path, { method, ...(method === 'POST' ? { json: { tournamentIds: ['olives'] } } : {}) });
    expect(res.status).toBe(401);
    expect(fake.requests.filter((r) => r.path.startsWith('/services/'))).toEqual([]);
  });

  it.each([
    ['no body', WED, undefined],
    ['an empty object', WED, {}],
    ['tournamentIds not an array', WED, { tournamentIds: 'olives' }],
    ['no tournaments', WED, { tournamentIds: [] }],
    ['21 tournaments', WED, { tournamentIds: Array.from({ length: 21 }, (_, i) => `t-${i}`) }],
    ['a tournament twice', WED, { tournamentIds: ['olives', 'olives'] }],
    ['a tournament id that could change the path', WED, { tournamentIds: ['../x'] }],
    ['a null tournament id', WED, { tournamentIds: [null] }],
    ['a bad date', '2026-13-01', { tournamentIds: ['olives'] }],
  ])('POST is 400 for %s, starting nothing', async (_what, date, body) => {
    await twoProfessorsWantingStaff();

    expect((await applyAll(body, date)).status).toBe(400);
    expect((await api(`/sessions/${WED}/staff/apply-all`)).status).toBe(204);
    expect(fake.requests.filter((r) => r.path.startsWith('/services/'))).toEqual([]);
  });

  it('accepts 20 tournaments', async () => {
    await twoProfessorsWantingStaff();

    const res = await applyAll({ tournamentIds: ['olives', ...Array.from({ length: 19 }, (_, i) => `t-${i}`)] });

    expect(res.status).toBe(202);
    const view = await finished(res.json().batchId);
    expect(view.rows).toHaveLength(20);
  });

  it('is 409 league_not_selected before a league is chosen', async () => {
    const res = await applyAll({ tournamentIds: ['olives'] });
    expect(res.status).toBe(409);
    expect(res.code()).toBe('league_not_selected');
    expect((await api(`/sessions/${WED}/staff/apply-all`)).code()).toBe('league_not_selected');
    expect((await api('/staff-batches/1')).code()).toBe('league_not_selected');
  });

  it("is 404 for a batch that doesn't exist, and 400 for one that can't", async () => {
    await twoProfessorsWantingStaff();

    const missing = await api('/staff-batches/41');
    expect(missing.status).toBe(404);
    expect(missing.code()).toBe('not_found');
    expect((await api('/staff-batches/x')).status).toBe(400);
  });

  it("assigns both professors' staff in turn, each as its organizer, and shows the batch", async () => {
    await twoProfessorsWantingStaff();

    const res = await applyAll({ tournamentIds: ['brocks', 'olives'] });

    expect(res.status).toBe(202);
    expect(res.json()).toEqual({ batchId: expect.any(Number) });
    const view = await finished(res.json().batchId);
    expect(view).toEqual({
      id: res.json().batchId,
      sessionDate: WED,
      status: 'succeeded',
      startedBy: 'organizer',
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      rows: [
        {
          position: 0,
          tournamentId: 'brocks',
          label: expect.stringContaining('Brock Cup'),
          organizerName: 'Brock Harrison',
          status: 'succeeded',
          submissionId: expect.any(Number),
          progress: null,
          counts: { added: 1, alreadyPresent: 0, failed: 0, skipped: 0 },
          refusal: null,
        },
        expect.objectContaining({ position: 1, tournamentId: 'olives', status: 'succeeded', counts: { added: 1, alreadyPresent: 0, failed: 0, skipped: 0 } }),
      ],
    });
    expect(staffWrites()).toEqual([
      ['brocks', BROCK],
      ['olives', FAKE_PLAYER_ID],
    ]);
    const history = (await api(`/submissions?date=${WED}`)).json().submissions as { kind: string; tournamentLabel: string }[];
    expect(history.filter((s) => s.kind === 'staff').map((s) => s.tournamentLabel)).toEqual([
      expect.stringContaining('Olive Cup'),
      expect.stringContaining('Brock Cup'),
    ]);
  });

  it('offers the running batch for its date, and none once it ends', async () => {
    await twoProfessorsWantingStaff();
    fake.staffPostDelayMs = 400;

    const { batchId } = (await applyAll({ tournamentIds: ['brocks', 'olives'] })).json();
    const running = await api(`/sessions/${WED}/staff/apply-all`);

    expect(running.status).toBe(200);
    expect(running.json()).toMatchObject({ id: batchId, status: 'running' });
    expect((await api('/sessions/2026-10-15/staff/apply-all')).status).toBe(204);
    await finished(batchId);
    expect((await api(`/sessions/${WED}/staff/apply-all`)).status).toBe(204);
  });

  it('starts one of two batches pressed at once, refusing the other with 409 submission_running, and any single apply meanwhile', async () => {
    await twoProfessorsWantingStaff();
    fake.staffPostDelayMs = 400;

    const [a, b] = await Promise.all([applyAll({ tournamentIds: ['brocks', 'olives'] }), applyAll({ tournamentIds: ['brocks', 'olives'] })]);

    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect((a.status === 409 ? a : b).code()).toBe('submission_running');
    const single = await api(`/sessions/${WED}/staff/apply`, { method: 'POST', json: { tournamentId: 'olives' } });
    expect(single.status).toBe(409);
    expect(single.code()).toBe('submission_running');
    await finished((a.status === 202 ? a : b).json().batchId);
  });

  it('records a tournament locked upstream as failed and still runs the next', async () => {
    await twoProfessorsWantingStaff();
    fake.lockedTournaments = new Set(['brocks']);

    const view = await finished((await applyAll({ tournamentIds: ['brocks', 'olives'] })).json().batchId);

    expect(view.status).toBe('partial');
    expect(view.rows.map((r: { status: string }) => r.status)).toEqual(['failed', 'succeeded']);
  });
});
