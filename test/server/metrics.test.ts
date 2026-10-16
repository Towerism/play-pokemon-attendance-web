import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, client, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };

/** `YYYY-MM-DD`, `weeksAgo` weeks before today on the server's clock (the test server runs in UTC). */
function weeksAgo(weeks: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 7 * weeks)).toISOString().slice(0, 10);
}
const TODAY = weeksAgo(0);

describe('metrics and curation API (M6)', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;

  beforeAll(async () => {
    server = await startServer({ env: { TZ: 'UTC' } });
    browser = client(server.url);
    const res = await browser.request('/api/auth/setup', {
      method: 'POST',
      json: { setupCode: await server.setupCode(), ...OWNER },
    });
    expect(res.status).toBe(200);
  });
  afterAll(() => server.dispose());

  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
  const json = async (path: string) => {
    const res = await api(path);
    expect(res.status).toBe(200);
    return res.json();
  };
  const ids = (players: { playerId: string }[]) => players.map((p) => p.playerId);

  describe('auth', () => {
    it.each([
      ['GET', '/api/players?filter=promote', undefined],
      ['GET', '/api/settings', undefined],
      ['PUT', '/api/settings', { thresholds: { promoteMinSightings: 4, staleAfterSessions: 6 } }],
      ['PUT', `/api/sessions/${TODAY}/regulars/1`, { present: true }],
    ])('%s %s is 401 without a session', async (method, path, body) => {
      expect((await client(server.url).request(path, { method, json: body })).status).toBe(401);
    });
  });

  describe('curation', () => {
    beforeAll(async () => {
      // Six weekly sessions: someone came every week.
      for (let w = 5; w >= 0; w--) {
        expect((await api(`/sessions/${weeksAgo(w)}/players`, { method: 'POST', json: { playerId: '900', name: 'Every week' } })).status).toBe(201);
      }
      // Ash came the last four weeks: a promotion candidate.
      for (let w = 3; w >= 0; w--) {
        await api(`/sessions/${weeksAgo(w)}/players`, { method: 'POST', json: { playerId: '0011', name: 'Ash' } });
      }
      await api(`/sessions/${weeksAgo(1)}/players`, { method: 'POST', json: { playerId: '12', name: 'Once' } });
      // Brock is a regular nobody has seen.
      expect((await api('/regulars', { method: 'POST', json: { playerId: '77', name: 'Brock' } })).status).toBe(201);
    });

    it('GET /players lists everyone with metrics, times submitted and flags, plus the thresholds', async () => {
      const body = await json('/players');

      expect(body.thresholds).toEqual({ promoteMinSightings: 4, staleAfterSessions: 6 });
      expect(ids(body.players)).toEqual(['0011', '77', '900', '12']);
      expect(body.players[0]).toEqual({
        playerId: '0011',
        displayName: 'Ash',
        isRegular: false,
        notes: null,
        firstSeenAt: expect.any(String),
        metrics: {
          sightingsTotal: 4,
          sightings4w: 4,
          sightings8w: 4,
          sightings12w: 4,
          attendanceRate8w: 4 / 6,
          firstSeen: weeksAgo(3),
          lastSeen: TODAY,
          currentStreak: 4,
          sessionsSinceLastSeen: 0,
          sessionsSinceLastPresent: 0,
        },
        timesSubmitted: 0,
        promotionCandidate: true,
        stale: false,
      });
      expect(body.players[1]).toMatchObject({ playerId: '77', isRegular: true, metrics: null, stale: true });
    });

    it('GET /players?filter=promote lists promotion candidates; ?filter=stale the stale regulars', async () => {
      expect(ids((await json('/players?filter=promote')).players)).toEqual(['900', '0011']);
      expect(ids((await json('/players?filter=stale')).players)).toEqual(['77']);
    });

    it('the search still applies within a filter', async () => {
      expect(ids((await json('/players?filter=promote&q=ash')).players)).toEqual(['0011']);
    });

    it('GET /players is 400 for an unknown filter', async () => {
      expect((await api('/players?filter=regulars')).status).toBe(400);
    });

    it('GET /regulars carries each regular’s metrics and stale flag', async () => {
      expect((await json('/regulars')).regulars).toEqual([
        { playerId: '77', displayName: 'Brock', regularSince: expect.any(String), notes: null, metrics: null, timesSubmitted: 0, stale: true },
      ]);
    });

    it('ticking a regular present on This week is evidence: they are no longer stale', async () => {
      const res = await api(`/sessions/${TODAY}/regulars/77`, { method: 'PUT', json: { present: true } });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ present: true, inTournament: false });
      expect((await json(`/sessions/${TODAY}`)).regulars).toEqual([expect.objectContaining({ playerId: '77', present: true, inTournament: false })]);
      expect((await json('/players?filter=stale')).players).toEqual([]);
      expect((await json('/regulars')).regulars[0].metrics).toMatchObject({ lastSeen: TODAY, sightingsTotal: 1 });

      const untick = await api(`/sessions/${TODAY}/regulars/77`, { method: 'PUT', json: { present: false } });
      expect(await untick.json()).toEqual({ present: false, inTournament: false });
      expect(ids((await json('/players?filter=stale')).players)).toEqual(['77']);
    });

    it('PUT /sessions/{date}/regulars/{id} is 404 for a player who is not a regular', async () => {
      const res = await api(`/sessions/${TODAY}/regulars/0011`, { method: 'PUT', json: { present: true } });
      expect(res.status).toBe(404);
    });

    it.each([
      ['a non-boolean present', `/sessions/${TODAY}/regulars/77`, { present: 'yes' }],
      ['an invalid date', '/sessions/2026-02-30/regulars/77', { present: true }],
      ['an invalid player id', `/sessions/${TODAY}/regulars/abc`, { present: true }],
    ])('PUT /sessions/{date}/regulars/{id} is 400 for %s', async (_l, path, body) => {
      expect((await api(path, { method: 'PUT', json: body })).status).toBe(400);
    });
  });

  describe('thresholds in Settings', () => {
    it('GET /settings has the defaults until the organizer changes them', async () => {
      expect((await json('/settings')).thresholds).toEqual({ promoteMinSightings: 4, staleAfterSessions: 6 });
    });

    it('PUT /settings stores new thresholds, and the curation views follow them', async () => {
      const res = await api('/settings', { method: 'PUT', json: { thresholds: { promoteMinSightings: 1, staleAfterSessions: 6 } } });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ thresholds: { promoteMinSightings: 1, staleAfterSessions: 6 } });
      expect((await json('/settings')).thresholds).toEqual({ promoteMinSightings: 1, staleAfterSessions: 6 });
      expect(ids((await json('/players?filter=promote')).players)).toEqual(['900', '0011', '12']);
    });

    it.each([
      ['zero', { thresholds: { promoteMinSightings: 0, staleAfterSessions: 6 } }],
      ['a missing threshold', { thresholds: { promoteMinSightings: 4 } }],
    ])('PUT /settings is 400 for %s, changing nothing', async (_l, body) => {
      expect((await api('/settings', { method: 'PUT', json: body })).status).toBe(400);
      expect((await json('/settings')).thresholds).toEqual({ promoteMinSightings: 1, staleAfterSessions: 6 });
    });
  });
});
