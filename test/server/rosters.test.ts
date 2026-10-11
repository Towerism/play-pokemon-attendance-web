import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };
const WED = '2026-10-14';

describe('roster and session API', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;

  beforeAll(async () => {
    server = await startServer();
    browser = client(server.url);
    const res = await browser.request('/api/auth/setup', {
      method: 'POST',
      json: { setupCode: setupCodeFrom(server.logs()), ...OWNER },
    });
    expect(res.status).toBe(200);
  });
  afterAll(() => server.dispose());

  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);

  describe('auth', () => {
    it.each([
      ['GET', '/api/players'],
      ['PATCH', '/api/players/1'],
      ['GET', '/api/regulars'],
      ['POST', '/api/regulars'],
      ['DELETE', '/api/regulars/1'],
      ['POST', '/api/regulars/import'],
      ['GET', `/api/sessions/${WED}`],
      ['POST', `/api/sessions/${WED}/players`],
      ['DELETE', `/api/sessions/${WED}/players/1`],
    ])('%s %s is 401 without a session', async (method, path) => {
      const res = await client(server.url).request(path, {
        method,
        json: method === 'GET' || method === 'DELETE' ? undefined : { playerId: '1' },
      });
      expect(res.status).toBe(401);
    });

    it('401 comes before validation, so an anonymous caller learns nothing about inputs', async () => {
      const res = await client(server.url).request('/api/sessions/not-a-date');
      expect(res.status).toBe(401);
    });
  });

  describe('regulars', () => {
    it('POST adds a regular (201), keeping the leading zeros of the id', async () => {
      const res = await api('/regulars', { method: 'POST', json: { playerId: '0012345', name: 'Ash Ketchum' } });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        regular: { playerId: '0012345', displayName: 'Ash Ketchum', regularSince: expect.any(String), notes: null },
      });
    });

    it('POST again is 200 and changes nothing', async () => {
      const res = await api('/regulars', { method: 'POST', json: { playerId: '0012345', name: 'Ash Ketchum' } });
      expect(res.status).toBe(200);
      expect((await (await api('/regulars')).json()).regulars).toHaveLength(1);
    });

    it.each([
      ['an empty body', {}],
      ['a non-digit id', { playerId: 'abc' }],
      ['a numeric id', { playerId: 12345 }],
      ['a name over 100 characters', { playerId: '1', name: 'x'.repeat(101) }],
    ])('POST 400 for %s', async (_label, json) => {
      expect((await api('/regulars', { method: 'POST', json })).status).toBe(400);
    });

    it('POST 415 for a non-JSON body (CSRF guard)', async () => {
      const res = await api('/regulars', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'playerId=1',
      });
      expect(res.status).toBe(415);
    });

    it('POST /regulars/import takes the CLI regulars.json as is', async () => {
      const res = await api('/regulars/import', {
        method: 'POST',
        json: [
          { name: 'Ash Ketchum', player_id: '0012345' },
          { name: 'Brock', player_id: '222' },
          { name: 'Misty', player_id: 333 },
        ],
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ added: 2, alreadyRegular: 1 });
      const { regulars } = await (await api('/regulars')).json();
      expect(regulars.map((r: { playerId: string }) => r.playerId)).toEqual(['0012345', '222', '333']);
    });

    it.each([
      ['an object instead of an array', { player_id: '1' }],
      ['an empty list', []],
      ['an invalid id', [{ player_id: 'abc' }]],
    ])('POST /regulars/import 400 for %s, importing nothing', async (_label, json) => {
      const before = (await (await api('/regulars')).json()).regulars.length;
      expect((await api('/regulars/import', { method: 'POST', json })).status).toBe(400);
      expect((await (await api('/regulars')).json()).regulars).toHaveLength(before);
    });

    it('DELETE removes a regular (204) and then 404s', async () => {
      expect((await api('/regulars/222', { method: 'DELETE' })).status).toBe(204);
      expect((await api('/regulars/222', { method: 'DELETE' })).status).toBe(404);
      const { regulars } = await (await api('/regulars')).json();
      expect(regulars.map((r: { playerId: string }) => r.playerId)).not.toContain('222');
    });

    it('DELETE 400 for an invalid id', async () => {
      expect((await api('/regulars/abc', { method: 'DELETE' })).status).toBe(400);
    });
  });

  describe('players', () => {
    it('GET lists every known player, regular or not', async () => {
      const { players } = await (await api('/players')).json();
      expect(players).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ playerId: '0012345', isRegular: true }),
          expect.objectContaining({ playerId: '222', displayName: 'Brock', isRegular: false }),
        ]),
      );
    });

    it('GET ?q= searches names and ids', async () => {
      const { players } = await (await api('/players?q=ketch')).json();
      expect(players.map((p: { playerId: string }) => p.playerId)).toEqual(['0012345']);
    });

    it('GET 400 for a filter that arrives with metrics', async () => {
      expect((await api('/players?filter=promote')).status).toBe(400);
    });

    it('PATCH renames, sets notes and toggles regular', async () => {
      const res = await api('/players/222', {
        method: 'PATCH',
        json: { name: 'Brock Harrison', notes: 'gym leader', isRegular: true },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        player: {
          playerId: '222',
          displayName: 'Brock Harrison',
          notes: 'gym leader',
          isRegular: true,
          firstSeenAt: expect.any(String),
        },
      });
    });

    it('PATCH 404 for an unknown player', async () => {
      expect((await api('/players/999999', { method: 'PATCH', json: { name: 'Nobody' } })).status).toBe(404);
    });

    it.each([{}, { isRegular: 'yes' }])('PATCH 400 for %j', async (json) => {
      expect((await api('/players/222', { method: 'PATCH', json })).status).toBe(400);
    });
  });

  describe('session players', () => {
    it('GET an untouched date is an empty draft that still shows the regulars', async () => {
      const res = await api(`/sessions/${WED}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ date: WED, status: 'draft', playSessionId: null, players: [] });
      expect(body.regulars.length).toBeGreaterThan(0);
    });

    it.each(['2026-02-30', '14-10-2026', 'today'])('GET 400 for date %s', async (date) => {
      expect((await api(`/sessions/${date}`)).status).toBe(400);
    });

    it('POST adds a session player (201), then 200 when repeated', async () => {
      const first = await api(`/sessions/${WED}/players`, { method: 'POST', json: { playerId: '0042', name: 'Gary Oak' } });
      expect(first.status).toBe(201);
      expect(await first.json()).toEqual({ player: { playerId: '0042', displayName: 'Gary Oak', source: 'manual' } });

      const again = await api(`/sessions/${WED}/players`, { method: 'POST', json: { playerId: '0042' } });
      expect(again.status).toBe(200);

      expect((await (await api(`/sessions/${WED}`)).json()).players).toEqual([
        { playerId: '0042', displayName: 'Gary Oak', source: 'manual' },
      ]);
    });

    it('POST 409 for a regular, who is submitted every session anyway', async () => {
      const res = await api(`/sessions/${WED}/players`, { method: 'POST', json: { playerId: '0012345' } });
      expect(res.status).toBe(409);
      expect((await res.json()).message).toMatch(/regular/i);
    });

    it('POST 400 for an invalid body', async () => {
      expect((await api(`/sessions/${WED}/players`, { method: 'POST', json: { playerId: 'x' } })).status).toBe(400);
    });

    it('DELETE takes the player off the date (204), then 404s', async () => {
      expect((await api(`/sessions/${WED}/players/0042`, { method: 'DELETE' })).status).toBe(204);
      expect((await api(`/sessions/${WED}/players/0042`, { method: 'DELETE' })).status).toBe(404);
      expect((await (await api(`/sessions/${WED}`)).json()).players).toEqual([]);
    });

    it('the player stays on file after leaving the session', async () => {
      const { players } = await (await api('/players?q=0042')).json();
      expect(players).toEqual([expect.objectContaining({ playerId: '0042', displayName: 'Gary Oak' })]);
    });
  });
});
