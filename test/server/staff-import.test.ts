import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
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

interface ImportView {
  id: number;
  kind: string;
  status: string;
  error: string | null;
  retryOf: number | null;
  playSessionLabel: string;
  undoable: boolean;
  items: { playerId: string; displayName: string; outcome: string }[];
  staffImport: {
    tournamentsTotal: number;
    tournamentsRead: number;
    tournamentsFailed: number;
    staffersFound: number;
    newPlayers: { playerId: string; name: string }[];
  };
}

describe('staff import API (POST /staff/import)', () => {
  let server: TestServer;
  let browser: Browser;
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
  const start = () => api('/staff/import', { method: 'POST' });
  const code = async (res: Response) => ((await res.json()) as { data?: { code?: string } }).data?.code;

  async function finished(submissionId: number): Promise<ImportView> {
    for (let i = 0; i < 200; i++) {
      const view = (await (await api(`/submissions/${submissionId}`)).json()) as ImportView;
      if (!['planned', 'running'].includes(view.status)) return view;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('staff import did not finish');
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
      fakeTournament('old', { startsAt: null, organizer: ORGANIZER }),
    ];
    fake.tournamentRecords = new Map([
      [
        'lc-wed',
        [
          fakeRecord(ORGANIZER, { role: 'organizer', first: 'Olive', last: 'Organizer' }),
          fakeRecord('00888', { first: 'Pat', last: 'Player' }),
          fakeRecord('00555', { role: 'judge', first: 'Jo', last: 'Judge' }),
        ],
      ],
      ['elsewhere', [fakeRecord(ORGANIZER, { role: 'organizer' }), fakeRecord('00555', { role: 'headjudge', first: 'Jo', last: 'Judge' })]],
      ['old', [fakeRecord(ORGANIZER, { role: 'organizer' }), fakeRecord('00777', { role: 'scorekeeper', first: 'Dead', last: 'Name' })]],
    ]);
    server = await startServer({ env: { ...fake.env, ...ENV } });
    browser = await login(server);
  });
  afterEach(async () => {
    expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
    await server.dispose();
  });

  it('is 401 without a session, before any upstream call', async () => {
    const res = await client(server.url).request('/api/staff/import', { method: 'POST' });
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

    it("reads every tournament the account organizes, any league or date, into the staff list", async () => {
      const view = await imported();

      expect(view).toMatchObject({ kind: 'staff_import', status: 'succeeded', playSessionLabel: 'Staff import', undoable: false });
      expect(view.staffImport).toEqual({
        tournamentsTotal: 3,
        tournamentsRead: 3,
        tournamentsFailed: 0,
        staffersFound: 2,
        newPlayers: [
          { playerId: '00777', name: 'Dead Name' },
          { playerId: '00555', name: 'Jo Judge' },
        ],
      });
      // Only reads: never a write to play-tools.
      expect(tournamentCalls().every((r) => r.method === 'GET')).toBe(true);
      const staff = (await (await api('/staff')).json()) as { playerId: string; timesStaffed: number }[];
      expect(staff.map((s) => [s.playerId, s.timesStaffed])).toEqual(
        expect.arrayContaining([
          ['00555', 2],
          ['00777', 1],
        ]),
      );
    });

    it('never replaces a name the organizer gave: a re-import keeps a rename', async () => {
      await imported();
      expect((await api('/players/00777', { method: 'PATCH', json: { name: 'Chosen Name' } })).status).toBe(200);

      const again = await imported();

      expect(again.items.map((i) => [i.playerId, i.outcome]).sort()).toEqual([
        ['00555', 'found'],
        ['00777', 'found'],
      ]);
      expect(again.items.find((i) => i.playerId === '00777')?.displayName).toBe('Chosen Name');
    });

    it('reads a tournament again after a 503, and succeeds', async () => {
      fake.failOnce.set('/services/core/tournaments/old/records', 503);

      const view = await imported();

      expect(view.status).toBe('succeeded');
      expect(tournamentCalls().filter((r) => r.path === '/services/core/tournaments/old/records')).toHaveLength(2);
    });

    it('is 409 submission_running while an import runs, and Retry starts a new attempt', async () => {
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
      expect(attempt).toMatchObject({ kind: 'staff_import', retryOf: done.id, status: 'succeeded' });
    });

    it('imports 10 tournaments in well under 5 s: reads are not paced', async () => {
      fake.tournaments = Array.from({ length: 10 }, (_, n) => fakeTournament(`t-${n}`, { startsAt: '2026-10-14T23:30:00Z', organizer: ORGANIZER }));
      fake.tournamentRecords = new Map(fake.tournaments.map((t) => [t.guid, [fakeRecord(ORGANIZER, { role: 'organizer' })]]));

      const began = Date.now();
      const view = await imported();

      expect(view.staffImport.tournamentsRead).toBe(10);
      expect(Date.now() - began).toBeLessThan(5_000);
    });

    it('logs player ids, never their names', async () => {
      await imported();
      expect(server.logs()).not.toMatch(/Jo Judge|Dead Name|Olive/);
    });
  });
});
