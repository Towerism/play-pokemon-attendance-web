import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakePokemon, type FakeRecord, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };
const ENV = { TZ: 'America/Chicago' };
const ORGANIZER = '9999991';

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

type Browser = ReturnType<typeof client>;

async function login(server: TestServer): Promise<Browser> {
  const browser = client(server.url);
  const res = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } });
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

/** Calls play-tools' tournament API: the listing and each tournament's records. */
const tournamentCalls = () => fake.requests.filter((r) => /\/services\/core\/(activities|tournaments?\/)/.test(r.path));

/** A player record carrying what play-tools also sends (S6) and the app must never keep. */
function playerRecord(playerId: string, first: string, last: string): FakeRecord {
  const r = fakeRecord(playerId, { first, last });
  return {
    ...r,
    division: 'masters',
    result: { place: 3 },
    match_results: [{ round: 1, outcome: 'win' }],
    participant: { ...r.participant, year_of_birth: 1987, user: { country: 'NZ' } },
  } as FakeRecord;
}

interface ImportView {
  id: number;
  kind: string;
  status: string;
  error: string | null;
  retryOf: number | null;
  playSessionLabel: string;
  undoable: boolean;
  items: { playerId: string; displayName: string; outcome: string }[];
  staffImport?: unknown;
  playerImport: {
    tournamentsTotal: number;
    tournamentsRead: number;
    tournamentsFailed: number;
    playersFound: number;
    newPlayers: { playerId: string; name: string }[];
  };
}

describe('player import API (POST /players/import)', () => {
  let server: TestServer;
  let browser: Browser;
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
  const start = () => api('/players/import', { method: 'POST' });
  const code = async (res: Response) => ((await res.json()) as { data?: { code?: string } }).data?.code;

  async function finished(submissionId: number): Promise<ImportView> {
    for (let i = 0; i < 200; i++) {
      const view = (await (await api(`/submissions/${submissionId}`)).json()) as ImportView;
      if (!['planned', 'running'].includes(view.status)) return view;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('player import did not finish');
  }

  async function imported(): Promise<ImportView> {
    const res = await start();
    expect(res.status).toBe(202);
    return finished(((await res.json()) as { submissionId: number }).submissionId);
  }

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.failOnce = new Map();
    fake.tournamentReadDelayMs = 0;
    fake.tournaments = [
      fakeTournament('lc-wed', { startsAt: '2026-10-14T23:30:00Z', organizer: ORGANIZER }),
      fakeTournament('elsewhere', { startsAt: '2026-09-02T23:00:00Z', groupId: 'another-store', organizer: ORGANIZER }),
      fakeTournament('cup', { startsAt: '2026-10-03T15:00:00Z', organizer: ORGANIZER }),
    ];
    fake.tournamentRecords = new Map([
      [
        'lc-wed',
        [
          fakeRecord(ORGANIZER, { role: 'organizer', first: 'Olive', last: 'Organizer' }),
          playerRecord('00888', 'Pat', 'Player'),
          fakeRecord('00555', { role: 'judge', first: 'Jo', last: 'Judge' }),
        ],
      ],
      ['elsewhere', [fakeRecord(ORGANIZER, { role: 'organizer' }), playerRecord('00444', 'Far', 'Away')]],
      ['cup', [fakeRecord(ORGANIZER, { role: 'organizer' }), playerRecord('00888', 'Pat', 'Player'), playerRecord('00999', 'Quinn', 'Quick')]],
    ]);
    server = await startServer({ env: { ...fake.env, ...ENV } });
    browser = await login(server);
  });
  afterEach(async () => {
    expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
    await server.dispose();
  });

  it('is 401 without a session, before any upstream call', async () => {
    const res = await client(server.url).request('/api/players/import', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(tournamentCalls()).toEqual([]);
  });

  it('is 409 not_connected before a Pokémon account is connected, and starts nothing', async () => {
    const res = await start();
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('not_connected');
    expect(await (await api('/submissions')).json()).toEqual({ submissions: [] });
  });

  describe('once connected', () => {
    beforeEach(async () => {
      await connect(browser);
      fake.requests.length = 0;
    });

    it("adds every tournament's players to the league, reading only, and never a former league's tournament", async () => {
      const view = await imported();

      expect(view).toMatchObject({ kind: 'player_import', status: 'succeeded', playSessionLabel: 'Player import', undoable: false });
      expect(view.staffImport).toBeUndefined();
      expect(view.playerImport).toEqual({
        tournamentsTotal: 2,
        tournamentsRead: 2,
        tournamentsFailed: 0,
        playersFound: 2,
        newPlayers: [
          { playerId: '00888', name: 'Pat Player' },
          { playerId: '00999', name: 'Quinn Quick' },
        ],
      });
      expect(tournamentCalls().filter((r) => r.path.includes('/tournaments/elsewhere'))).toEqual([]);
      expect(tournamentCalls().every((r) => r.method === 'GET')).toBe(true);
    });

    it('lets the player search find a player the app did not know before', async () => {
      const search = async () => ((await (await api('/players?q=quinn')).json()) as { players: { playerId: string; displayName: string }[] }).players;
      expect(await search()).toEqual([]);

      await imported();

      expect(await search()).toEqual([expect.objectContaining({ playerId: '00999', displayName: 'Quinn Quick' })]);
    });

    it('returns and logs nothing of a player but their id and name', async () => {
      const res = await start();
      const { submissionId } = (await res.json()) as { submissionId: number };
      await finished(submissionId);

      const body = await (await api(`/submissions/${submissionId}`)).text();
      expect(body).not.toMatch(/1987|NZ|masters|year_of_birth|match_results|place/);
      expect(server.logs()).not.toMatch(/Pat Player|Quinn|Olive/);
    });

    it('never replaces a name the organizer gave: a re-import keeps a rename', async () => {
      await imported();
      expect((await api('/players/00888', { method: 'PATCH', json: { name: 'Patricia P.' } })).status).toBe(200);

      const again = await imported();

      expect(again.items.find((i) => i.playerId === '00888')).toMatchObject({ outcome: 'found', displayName: 'Patricia P.' });
    });

    it('is 409 submission_running while an import runs, Retry starts a new attempt, and Undo is refused', async () => {
      fake.tournamentReadDelayMs = 300;
      const first = await start();
      expect(first.status).toBe(202);
      const second = await start();
      expect(second.status).toBe(409);
      expect(await code(second)).toBe('submission_running');
      const done = await finished(((await first.json()) as { submissionId: number }).submissionId);
      fake.tournamentReadDelayMs = 0;

      const retried = await api(`/submissions/${done.id}/retry`, { method: 'POST' });
      expect(retried.status).toBe(202);
      const attempt = await finished(((await retried.json()) as { submissionId: number }).submissionId);
      expect(attempt).toMatchObject({ kind: 'player_import', retryOf: done.id, status: 'succeeded' });

      const undo = await api(`/submissions/${done.id}/undo`, { method: 'POST' });
      expect(undo.status).toBe(422);
      expect(await code(undo)).toBe('not_undoable');
    });
  });
});
