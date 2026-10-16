import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, client, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };
const ids = (players: { playerId: string }[]) => players.map((p) => p.playerId);

/** `GET /api/players` as the This week search box calls it: `q` plus a `limit`. */
describe('player search API', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;

  beforeAll(async () => {
    server = await startServer();
    browser = client(server.url);
    const res = await browser.request('/api/auth/setup', {
      method: 'POST',
      json: { setupCode: await server.setupCode(), ...OWNER },
    });
    expect(res.status).toBe(200);

    // 2,000 known players: 9000000–9001999, named "Trainer <n>". Two more for the exact-id case.
    const file = Array.from({ length: 2000 }, (_, i) => ({ player_id: `${9_000_000 + i}`, name: `Trainer ${i}` }));
    expect((await api('/regulars/import', { method: 'POST', json: file })).status).toBe(200);
    for (const player of [
      { playerId: '12345', name: 'Aaron' },
      { playerId: '1234', name: 'Zed' },
    ]) {
      expect((await api('/sessions/2026-09-02/players', { method: 'POST', json: player })).status).toBe(201);
    }
  });
  afterAll(() => server.dispose());

  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
  const search = async (query: string) => {
    const res = await api(`/players?${query}`);
    expect(res.status).toBe(200);
    return (await res.json()).players as { playerId: string; displayName: string; isRegular: boolean }[];
  };

  it('is 401 without a session', async () => {
    expect((await client(server.url).request('/api/players?q=trainer&limit=20')).status).toBe(401);
  });

  it('caps the matches at limit', async () => {
    expect(await search('q=trainer&limit=20')).toHaveLength(20);
  });

  it('returns every match without a limit', async () => {
    expect(await search('q=trainer')).toHaveLength(2000);
  });

  it('matches part of a player id', async () => {
    expect(ids(await search('q=900199&limit=20'))).toEqual(Array.from({ length: 10 }, (_, i) => `${9_001_990 + i}`));
  });

  it('puts the exact id match first, ahead of names that sort earlier', async () => {
    expect(ids(await search('q=1234&limit=1'))).toEqual(['1234']);
  });

  it('carries what the search box needs to tag each result', async () => {
    const [player] = await search('q=9000007&limit=1');
    expect(player).toMatchObject({ playerId: '9000007', displayName: 'Trainer 7', isRegular: true });
  });

  it('matches LIKE wildcards literally', async () => {
    expect(await search('q=_&limit=20')).toEqual([]);
    expect(await search('q=%25&limit=20')).toEqual([]);
  });

  it.each(['0', '101', '2.5', 'abc', '-1', ''])('is 400 for limit=%j', async (limit) => {
    expect((await api(`/players?q=trainer&limit=${limit}`)).status).toBe(400);
  });

  it('answers a two-character search over 2,000 players in under 200 ms', async () => {
    await search('q=12&limit=20'); // warm up
    const started = performance.now();
    const players = await search('q=12&limit=20');
    const elapsed = performance.now() - started;

    expect(players).toHaveLength(20);
    expect(elapsed).toBeLessThan(200);
  });
});
