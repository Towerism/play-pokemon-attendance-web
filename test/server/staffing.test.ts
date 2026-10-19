import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PLAYER_ID, type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };
const ENV = { TZ: 'America/Chicago' };
const WED = '2026-10-14';
const T = 'lc-wed';
const ORGANIZER = '9999991';

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

type Browser = ReturnType<typeof client>;

async function login(server: TestServer, setup: boolean): Promise<Browser> {
  const browser = client(server.url);
  const res = setup
    ? await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } })
    : await browser.request('/api/auth/login', { method: 'POST', json: OWNER });
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

/** Calls play-tools' tournament or staff API (not the login). */
const tournamentCalls = () => fake.requests.filter((r) => /\/services\/core\/(activities|tournaments?\/)/.test(r.path));

describe('staffing API', () => {
  let server: TestServer;
  let browser: Browser;
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
  const add = (body: Record<string, unknown>) => api(`/sessions/${WED}/staff`, { method: 'POST', json: { tournamentId: T, role: 'judge', ...body } });
  const code = async (res: Response) => ((await res.json()) as { data?: { code?: string } }).data?.code;

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.tournaments = [
      // 18:30 on Wednesday in Chicago, already Thursday in UTC.
      fakeTournament(T, { startsAt: '2026-10-14T23:30:00Z', organizer: ORGANIZER, name: 'League Challenge' }),
      fakeTournament('elsewhere', { startsAt: '2026-10-14T23:00:00Z', groupId: 'another-store' }),
      fakeTournament('old', { startsAt: '2026-06-03T23:30:00Z' }),
    ];
    fake.tournamentRecords = new Map([
      [T, [fakeRecord(ORGANIZER, { role: 'organizer' }), fakeRecord('00888'), fakeRecord('00555', { role: 'judge', first: 'Jo', last: 'Judge' })]],
      ['old', [fakeRecord(ORGANIZER, { role: 'organizer' })]],
    ]);
    server = await startServer({ env: { ...fake.env, ...ENV } });
    browser = await login(server, true);
  });
  afterEach(async () => {
    expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
    await server.dispose();
  });

  describe('auth', () => {
    it.each([
      ['GET', '/api/staff'],
      ['GET', '/api/staff/roles'],
      ['GET', `/api/sessions/${WED}/staff`],
      ['POST', `/api/sessions/${WED}/staff`],
      ['PATCH', `/api/sessions/${WED}/staff/1`],
      ['DELETE', `/api/sessions/${WED}/staff/1`],
    ])('%s %s is 401 without a session, before any validation or upstream call', async (method, path) => {
      const res = await client(server.url).request(path, { method, json: ['POST', 'PATCH'].includes(method) ? {} : undefined });
      expect(res.status).toBe(401);
      expect(tournamentCalls()).toEqual([]);
    });
  });

  describe('GET /staff/roles', () => {
    it("offers play-tools' staff roles, judge first, without calling play-tools", async () => {
      const res = await api('/staff/roles');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        roles: [
          { code: 'judge', label: 'Judge' },
          { code: 'headjudge', label: 'Head Judge' },
          { code: 'scorekeeper', label: 'Scorekeeper' },
          { code: 'administration', label: 'Support Staff' },
          { code: 'translator', label: 'Translator' },
        ],
      });
      const apiCalls = fake.requests.filter((r) => r.path.startsWith('/services/'));
      expect(apiCalls, JSON.stringify(fake.requests)).toEqual([]);
    });
  });

  describe('before a Pokémon account is connected', () => {
    it('is 409 not_connected for the routes that read play-tools', async () => {
      const res = await api(`/sessions/${WED}/staff`);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('not_connected');
      expect((await add({ playerId: '00999' })).status).toBe(409);
    });

    it('still searches the staff list', async () => {
      const res = await api('/staff');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  describe('once connected', () => {
    beforeEach(async () => {
      await connect(browser);
      fake.requests.length = 0;
    });

    it("shows the date's tournaments in this league with who play-tools lists, and seeds the staff list", async () => {
      const res = await api(`/sessions/${WED}/staff`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        timeZone: 'America/Chicago',
        tournaments: [
          {
            tournamentId: T,
            label: `League Challenge · 26-10-${T}`,
            startsAt: '2026-10-14T23:30:00.000Z',
            editable: true,
            organizer: { playerId: ORGANIZER, name: null, connected: true, needsReconnect: false },
            assignments: [],
            upstreamOnly: [{ playerId: '00555', name: 'Jo Judge', role: 'judge' }],
            players: [{ playerId: '00888' }],
          },
        ],
        unread: [],
      });

      const staff = await (await api('/staff')).json();
      expect(staff).toEqual([{ playerId: '00555', name: 'Jo Judge', timesStaffed: 1, lastStaffedOn: WED, lastRole: 'judge' }]);
    });

    it('adds a staffer (201), answers a repeat with 200, and shows them on the card', async () => {
      const first = await add({ playerId: '00999', name: 'Brock' });
      expect(first.status).toBe(201);
      const { assignment } = (await first.json()) as { assignment: { id: number } };
      expect(assignment).toEqual({ id: expect.any(Number), playerId: '00999', name: 'Brock', role: 'judge', appliedRole: null, state: 'pending' });

      const again = await add({ playerId: '00999' });
      expect(again.status).toBe(200);
      expect((await again.json()).assignment.id).toBe(assignment.id);

      const card = await (await api(`/sessions/${WED}/staff`)).json();
      expect(card.tournaments[0].assignments).toEqual([expect.objectContaining({ id: assignment.id, playerId: '00999' })]);
    });

    it.each([
      [{ playerId: '00999', role: 'scorekeeper' }, 409, 'player_already_staffed', true],
      [{ playerId: '00999', role: 'organizer' }, 422, 'unknown_role', false],
      [{ playerId: '00999', role: 'wizard' }, 422, 'unknown_role', false],
      [{ playerId: ORGANIZER }, 422, 'organizer_cannot_staff', false],
      [{ playerId: '00888' }, 409, 'already_listed', false],
      [{ playerId: '00999', tournamentId: 'elsewhere' }, 422, 'unknown_tournament', false],
      [{ playerId: '00999', tournamentId: 'nope' }, 422, 'unknown_tournament', false],
    ])('refuses %j with %i %s', async (body, status, errorCode, judgeFirst) => {
      if (judgeFirst) expect((await add({ playerId: '00999' })).status).toBe(201);
      const res = await add(body);
      expect(res.status).toBe(status);
      expect(await code(res)).toBe(errorCode);
    });

    it('says how play-tools already lists someone', async () => {
      const res = await add({ playerId: '00555' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { data: unknown }).data).toEqual({ code: 'already_listed', how: 'staff' });
    });

    it('refuses a tournament past its edit window', async () => {
      const res = await api('/sessions/2026-06-03/staff', { method: 'POST', json: { tournamentId: 'old', playerId: '00999', role: 'judge' } });
      expect(res.status).toBe(422);
      expect(await code(res)).toBe('tournament_locked');
    });

    it('is 502 unavailable when play-tools fails, and adds nobody', async () => {
      fake.failOnce.set(`/services/core/tournament/${T}`, 503);
      const res = await add({ playerId: '00999' });
      expect(res.status).toBe(502);
      expect(await code(res)).toBe('unavailable');
      const card = await (await api(`/sessions/${WED}/staff`)).json();
      expect(card.tournaments[0].assignments).toEqual([]);
    });

    it.each([
      { tournamentId: '../x' },
      { tournamentId: 'x'.repeat(65) },
      { playerId: '12a' },
      { role: '' },
      { playerId: undefined },
    ])('is 400 for %j, before calling play-tools', async (patch) => {
      const res = await add({ playerId: '00999', ...patch });
      expect(res.status).toBe(400);
      expect(tournamentCalls()).toEqual([]);
    });

    it('treats 00123 and 123 as different players', async () => {
      expect((await add({ playerId: '00123' })).status).toBe(201);
      expect((await add({ playerId: '123', role: 'scorekeeper' })).status).toBe(201);
    });

    describe('PATCH and DELETE', () => {
      let assignmentId: number;
      beforeEach(async () => {
        assignmentId = ((await (await add({ playerId: '00999' })).json()) as { assignment: { id: number } }).assignment.id;
      });
      const patch = (body: unknown, id: number | string = assignmentId, date = WED) =>
        api(`/sessions/${date}/staff/${id}`, { method: 'PATCH', json: body });

      it('changes the role of a pending assignment', async () => {
        const res = await patch({ role: 'scorekeeper' });
        expect(res.status).toBe(200);
        expect((await res.json()).assignment).toMatchObject({ id: assignmentId, role: 'scorekeeper', appliedRole: null, state: 'pending' });
      });

      it('is 422 unknown_role, 404 for an unknown id or another date, and 400 for a bad id or body', async () => {
        const unknown = await patch({ role: 'organizer' });
        expect([unknown.status, await code(unknown)]).toEqual([422, 'unknown_role']);
        const missing = await patch({ role: 'judge' }, assignmentId + 100);
        expect([missing.status, await code(missing)]).toEqual([404, 'not_found']);
        expect((await patch({ role: 'judge' }, assignmentId, '2026-10-21')).status).toBe(404);
        expect((await patch({ role: 'judge' }, 'abc')).status).toBe(400);
        expect((await patch({})).status).toBe(400);
      });

      it('deletes a pending assignment (204), then 404', async () => {
        const del = () => api(`/sessions/${WED}/staff/${assignmentId}`, { method: 'DELETE' });
        expect((await del()).status).toBe(204);
        expect((await del()).status).toBe(404);
        const card = await (await api(`/sessions/${WED}/staff`)).json();
        expect(card.tournaments[0].assignments).toEqual([]);
      });
    });

    it('keeps the league chosen across a disconnect and a reconnect, even once the account has several leagues (ADR-0015 §3)', async () => {
      fake.leagues.push({ guid: 'group-2', display_id: 'L7000', display_name: 'Game Den', canSubmit: true });
      try {
        await api(`/pokemon/connections/${FAKE_PLAYER_ID}`, { method: 'DELETE' });
        await connect(browser);
        const res = await api(`/sessions/${WED}/staff`);
        expect(res.status).toBe(200);
      } finally {
        fake.leagues.pop();
      }
    });
  });

  describe('GET /staff', () => {
    it('returns a bare array, searches by name or id, caps at limit, and refuses a bad limit', async () => {
      await connect(browser);
      fake.tournamentRecords.get(T)!.push(fakeRecord('00556', { role: 'scorekeeper', first: 'Sam', last: 'Scorer' }));
      await api(`/sessions/${WED}/staff`);

      expect(((await (await api('/staff?q=sam')).json()) as { playerId: string }[]).map((s) => s.playerId)).toEqual(['00556']);
      expect(((await (await api('/staff?q=0055')).json()) as unknown[]).length).toBe(2);
      expect(((await (await api('/staff?limit=1')).json()) as unknown[]).length).toBe(1);
      expect((await api('/staff?limit=0')).status).toBe(400);
    });
  });
});

describe('staff list search speed', () => {
  it('answers a search over 5,000 staffing rows and 1,000 players in under 100 ms at p95', async () => {
    let server = await startServer({ env: { ...fake.env, ...ENV } });
    await login(server, true);
    await server.stop();

    const db = new Database(join(server.dataDir, 'app.db'));
    db.transaction(() => {
      const player = db.prepare("insert into player (player_id, display_name, first_seen_at) values (?, ?, 0)");
      const member = db.prepare("insert into player_membership (league_id, player_id) values ('default', ?)");
      const row = db.prepare(
        "insert into staff_history (league_id, tournament_id, player_id, tournament_date, role, source, recorded_at) values ('default', ?, ?, ?, 'judge', 'upstream', 0)",
      );
      for (let p = 0; p < 1000; p++) {
        player.run(`${7_000_000 + p}`, `Staffer ${p}`);
        member.run(`${7_000_000 + p}`);
      }
      for (let i = 0; i < 5000; i++) {
        const day = String(1 + (i % 28)).padStart(2, '0');
        row.run(`t-${Math.floor(i / 5)}`, `${7_000_000 + (i % 1000)}`, `2026-${String(1 + (i % 9)).padStart(2, '0')}-${day}`);
      }
    })();
    db.close();

    server = await startServer({ env: { ...fake.env, ...ENV }, dataDir: server.dataDir });
    try {
      const browser = await login(server, false);
      const timings: number[] = [];
      for (let i = 0; i < 50; i++) {
        const started = performance.now();
        const res = await browser.request('/api/staff?q=a&limit=20');
        timings.push(performance.now() - started);
        expect(res.status).toBe(200);
        expect(((await res.json()) as unknown[]).length).toBe(20);
      }
      timings.sort((a, b) => a - b);
      expect(timings[Math.ceil(0.95 * timings.length) - 1]).toBeLessThan(100);
    } finally {
      await server.dispose();
    }
  });
});
