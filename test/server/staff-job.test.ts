import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };
// The floor (500 ms) keeps these tests quick without turning pacing off.
const ENV = { TZ: 'America/Chicago', NUXT_STAFF_DELAY_MS: '0' };
const WED = '2026-10-14';
const T = 'lc-wed';
const ORGANIZER = '9999991';

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

type Browser = ReturnType<typeof client>;

async function login(server: TestServer): Promise<Browser> {
  const browser = client(server.url);
  const res = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } });
  expect(res.status).toBe(200);
  return browser;
}

async function connect(browser: Browser) {
  const start = await browser.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL(((await start.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state');
  const res = await browser.request('/api/pokemon/connect/complete', {
    method: 'POST',
    json: { url: `https://play-tools.pokemon.com/loggedIn?code=fresh&state=${state}` },
  });
  expect(res.status).toBe(200);
}

/** Staff writes play-tools received, in order. */
const staffWrites = () => fake.requests.filter((r) => r.method !== 'GET' && /\/services\/core\/tournaments\/[^/]+\/records/.test(r.path));
const listed = (tournamentId = T) => (fake.tournamentRecords.get(tournamentId) ?? []).map((r) => [r.participant.player_id, r.role]);

describe('staff job API (POST /sessions/{date}/staff/apply)', () => {
  let server: TestServer;
  let browser: Browser;
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
  const apply = (body: unknown = { tournamentId: T }, date = WED) => api(`/sessions/${date}/staff/apply`, { method: 'POST', json: body });
  const want = async (playerId: string, role = 'judge', name = `Staffer ${playerId}`) => {
    const res = await api(`/sessions/${WED}/staff`, { method: 'POST', json: { tournamentId: T, playerId, role, name } });
    expect(res.status).toBe(201);
    return ((await res.json()) as { assignment: { id: number } }).assignment.id;
  };
  const code = async (res: Response) => ((await res.json()) as { data?: { code?: string } }).data?.code;

  async function finished(submissionId: number) {
    for (let i = 0; i < 200; i++) {
      const view = await (await api(`/submissions/${submissionId}`)).json();
      if (!['planned', 'running'].includes(view.status)) return view;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('staff job did not finish');
  }

  async function applied(body?: unknown) {
    const res = await apply(body);
    expect(res.status).toBe(202);
    return finished(((await res.json()) as { submissionId: number }).submissionId);
  }

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.lockedTournaments = new Set();
    fake.refuseStaff = new Map();
    fake.tournaments = [
      // 18:30 on Wednesday in Chicago, already Thursday in UTC.
      fakeTournament(T, { startsAt: '2026-10-14T23:30:00Z', organizer: ORGANIZER, name: 'League Challenge' }),
      fakeTournament('elsewhere', { startsAt: '2026-10-14T23:00:00Z', groupId: 'another-store' }),
      fakeTournament('old', { startsAt: '2026-06-03T23:30:00Z' }),
    ];
    fake.tournamentRecords = new Map([
      [T, [fakeRecord(ORGANIZER, { role: 'organizer' }), fakeRecord('00888')]],
      ['old', [fakeRecord(ORGANIZER, { role: 'organizer' })]],
    ]);
    server = await startServer({ env: { ...fake.env, ...ENV } });
    browser = await login(server);
  });
  afterEach(async () => {
    expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
    await server.dispose();
  });

  it('is 401 without a session, before any validation or upstream call', async () => {
    const res = await client(server.url).request(`/api/sessions/${WED}/staff/apply`, { method: 'POST', json: {} });
    expect(res.status).toBe(401);
    expect(fake.requests.filter((r) => r.path.startsWith('/services/'))).toEqual([]);
  });

  it.each([
    ['no tournament', WED, {}],
    ['a tournament id that could change the path', WED, { tournamentId: '../x' }],
    ['a bad date', '2026-13-01', { tournamentId: T }],
  ])('is 400 for %s', async (_what, date, body) => {
    expect((await apply(body, date)).status).toBe(400);
  });

  it('is 409 not_connected before a Pokémon account is connected', async () => {
    const res = await apply();
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('not_connected');
  });

  describe('once connected', () => {
    beforeEach(async () => {
      await connect(browser);
      fake.requests.length = 0;
    });

    it('assigns the wanted staff in play-tools and shows the job in History', async () => {
      await want('00999', 'judge', 'Ash Ketchum');
      await want('00777', 'scorekeeper');

      const view = await applied();

      expect(listed()).toEqual(expect.arrayContaining([['00999', 'judge'], ['00777', 'scorekeeper']]));
      expect(staffWrites().map((w) => [w.method, (w.body as { participant: { player_id: string } }).participant.player_id])).toEqual([
        ['POST', '00999'],
        ['POST', '00777'],
      ]);
      expect(view).toMatchObject({
        kind: 'staff',
        status: 'succeeded',
        playSessionId: T,
        playSessionLabel: `Staff for League Challenge · 26-10-${T}`,
        tournamentLabel: `League Challenge · 26-10-${T}`,
        undoable: false,
        counts: { added: 2, alreadyPresent: 0, failed: 0, skipped: 0, unrequested: 0 },
      });
      expect(view.items).toContainEqual(
        expect.objectContaining({ playerId: '00999', outcome: 'assigned', role: 'judge', errorCode: null, suggestedPlayerId: null }),
      );
      const { submissions: history } = (await (await api(`/submissions?date=${WED}`)).json()) as {
        submissions: { kind: string; tournamentLabel: string | null }[];
      };
      expect(history).toEqual([expect.objectContaining({ kind: 'staff', tournamentLabel: `League Challenge · 26-10-${T}` })]);
      const card = (await (await api(`/sessions/${WED}/staff`)).json()) as { tournaments: { assignments: { state: string }[] }[] };
      expect(card.tournaments[0]!.assignments.map((a) => a.state)).toEqual(['assigned', 'assigned']);
      expect(server.logs()).not.toContain('Ash');
    });

    it('keeps writes at least 500 ms apart even when NUXT_STAFF_DELAY_MS asks for less', async () => {
      await want('00999');
      await want('00777');

      await applied();

      // The app spaces writes on its own clock; the fake stamps them on arrival (see the undo spacing test).
      const JITTER_MS = 50;
      const [first, second] = staffWrites();
      expect(second!.at! - first!.at!).toBeGreaterThanOrEqual(500 - JITTER_MS);
    });

    it('records an eligibility refusal as ineligible with its code', async () => {
      await want('00999');
      fake.refuseStaff.set('00999', 'op.activity_record.missing_certification');

      const view = await applied();

      expect(view.status).toBe('failed');
      expect(view.items).toEqual([
        expect.objectContaining({ playerId: '00999', outcome: 'ineligible', errorCode: 'missing_certification', error: expect.stringContaining('Not certified') }),
      ]);
    });

    it('stops as tournament_locked when play-tools answers 423, sending nothing more', async () => {
      await want('00999');
      await want('00777');
      fake.lockedTournaments.add(T);

      const view = await applied();

      expect(staffWrites()).toHaveLength(1);
      expect(view).toMatchObject({ status: 'failed', error: 'tournament_locked' });
      expect(Object.fromEntries(view.items.map((i: { playerId: string; outcome: string }) => [i.playerId, i.outcome]))).toEqual({
        '00999': 'failed',
        '00777': 'skipped',
      });
    });

    it('retries a failed job as a new staff job, and refuses to undo one', async () => {
      await want('00999');
      fake.refuseStaff.set('00999', 'op.activity_record.missing_certification');
      const first = await applied();
      fake.refuseStaff.clear();

      const retried = await api(`/submissions/${first.id}/retry`, { method: 'POST' });
      expect(retried.status).toBe(202);
      const view = await finished(((await retried.json()) as { submissionId: number }).submissionId);
      expect(view).toMatchObject({ kind: 'staff', retryOf: first.id, status: 'succeeded' });

      const undo = await api(`/submissions/${view.id}/undo`, { method: 'POST' });
      expect(undo.status).toBe(422);
      expect(await code(undo)).toBe('not_undoable');
    });

    it.each([
      ['nothing_to_apply', WED, T],
      ['unknown_tournament', WED, 'elsewhere'],
      ['unknown_tournament', WED, 'nope'],
      ['tournament_locked', '2026-06-03', 'old'],
    ])('is 422 %s, and starts nothing', async (expected, date, tournamentId) => {
      const res = await apply({ tournamentId }, date);
      expect(res.status).toBe(422);
      expect(await code(res)).toBe(expected);
      expect(await (await api('/submissions')).json()).toEqual({ submissions: [] });
    });
  });
});
