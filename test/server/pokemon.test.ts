import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakePokemon, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

async function bootApp(dataDir?: string): Promise<{ server: TestServer; browser: ReturnType<typeof client> }> {
  const server = await startServer({ env: fake.env, dataDir });
  const browser = client(server.url);
  if (!dataDir) {
    const res = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } });
    expect(res.status).toBe(200);
  } else {
    expect((await browser.request('/api/auth/login', { method: 'POST', json: OWNER })).status).toBe(200);
  }
  return { server, browser };
}

/** Starts a connect and pastes back the URL play-tools would show after the login. */
async function connect(browser: ReturnType<typeof client>, code = 'fresh-code') {
  const start = await browser.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  expect(start.status).toBe(200);
  const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
  const state = new URL(authorizeUrl).searchParams.get('state');
  return browser.request('/api/pokemon/connect/complete', {
    method: 'POST',
    json: { url: `https://play-tools.pokemon.com/loggedIn?code=${code}&state=${state}&scope=openid+organized_play+offline` },
  });
}

describe('Pokémon connection API', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.accessTtl = 3599;
    fake.leagues = [{ guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true }];
    ({ server, browser } = await bootApp());
  });
  afterEach(async () => {
    expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
    await server.dispose();
  });

  describe('auth', () => {
    it.each([
      ['GET', '/api/pokemon/connection'],
      ['DELETE', '/api/pokemon/connection'],
      ['POST', '/api/pokemon/connect/start'],
      ['POST', '/api/pokemon/connect/complete'],
      ['GET', '/api/leagues/upstream'],
      ['PUT', '/api/settings'],
    ])('%s %s is 401 without a session, before any validation', async (method, path) => {
      const res = await client(server.url).request(path, { method, json: method === 'GET' || method === 'DELETE' ? undefined : {} });
      expect(res.status).toBe(401);
      expect(fake.requests).toEqual([]);
    });
  });

  it('is not connected on a fresh install', async () => {
    const res = await api('/pokemon/connection');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'not_connected', reason: null, connectedAt: null, lastRefreshedAt: null, league: null });
  });

  describe('POST /pokemon/connect/start', () => {
    it("returns Pokémon's login URL with a PKCE challenge and state, and calls nothing upstream", async () => {
      const res = await api('/pokemon/connect/start', { method: 'POST', json: {} });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authorizeUrl: string; expiresAt: string };
      const url = new URL(body.authorizeUrl);
      expect(url.origin + url.pathname).toBe(`${fake.url}/oauth2/auth`);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('redirect_uri')).toBe('https://play-tools.pokemon.com/loggedIn');
      expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
      expect(fake.requests).toEqual([]);
    });
  });

  describe('POST /pokemon/connect/complete', () => {
    it('connects, binds the only league, and never returns a token', async () => {
      const res = await connect(browser);

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toMatch(/ory_rt_|eyJ/);
      expect(JSON.parse(text)).toEqual({
        status: 'connected',
        reason: null,
        connectedAt: expect.any(String),
        lastRefreshedAt: expect.any(String),
        league: { id: 'group-1', name: 'Card Shop', displayId: 'L5012', canSubmit: true },
      });
      const exchange = fake.requests.find((r) => r.form?.grant_type === 'authorization_code');
      expect(exchange?.form).toMatchObject({ code: 'fresh-code', code_verifier: expect.stringMatching(/^[\w-]{43}$/) });
      expect((await (await api('/pokemon/connection')).json()).status).toBe('connected');
    });

    it.each([
      ['missing', {}],
      ['empty', { url: '' }],
    ])('is 400 when the url is %s', async (_l, json) => {
      expect((await api('/pokemon/connect/complete', { method: 'POST', json })).status).toBe(400);
    });

    it('is 400 invalid_url for something that is not the play-tools address', async () => {
      await api('/pokemon/connect/start', { method: 'POST', json: {} });
      const res = await api('/pokemon/connect/complete', { method: 'POST', json: { url: 'https://evil.example/loggedIn?code=a&state=b' } });
      expect(res.status).toBe(400);
      expect((await res.json()).data).toEqual({ code: 'invalid_url' });
    });

    it('is 400 unknown_attempt for a state this app never issued, without calling Pokémon', async () => {
      const res = await api('/pokemon/connect/complete', {
        method: 'POST',
        json: { url: 'https://play-tools.pokemon.com/loggedIn?code=a&state=forged' },
      });
      expect(res.status).toBe(400);
      expect((await res.json()).data).toEqual({ code: 'unknown_attempt' });
      expect(fake.requests).toEqual([]);
    });

    it('is 400 code_rejected when Pokémon refuses the code, and stays disconnected', async () => {
      const res = await connect(browser, 'used');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.data).toEqual({ code: 'code_rejected' });
      expect(body.message).toMatch(/already been used/);
      expect((await (await api('/pokemon/connection')).json()).status).toBe('not_connected');
    });
  });

  describe('league discovery', () => {
    it('is 409 not_connected before connecting', async () => {
      const res = await api('/leagues/upstream');
      expect(res.status).toBe(409);
      expect((await res.json()).data).toEqual({ code: 'not_connected' });
    });

    it("lists the organizer's leagues and lets them choose one", async () => {
      fake.leagues.push({ guid: 'group-2', display_id: 'L7000', display_name: 'Game Den', canSubmit: false });
      expect((await (await connect(browser)).json()).league).toBeNull();

      const list = await api('/leagues/upstream');
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({
        leagues: [
          { id: 'group-1', name: 'Card Shop', displayId: 'L5012', canSubmit: true },
          { id: 'group-2', name: 'Game Den', displayId: 'L7000', canSubmit: false },
        ],
        selectedId: null,
      });

      const put = await api('/settings', { method: 'PUT', json: { activityGroupId: 'group-2' } });
      expect(put.status).toBe(200);
      expect((await put.json()).connection.league).toEqual({ id: 'group-2', name: 'Game Den', displayId: 'L7000', canSubmit: false });
      expect((await (await api('/pokemon/connection')).json()).league.id).toBe('group-2');
    });

    it('PUT /settings is 422 unknown_league for a group the account does not have', async () => {
      await connect(browser);
      const res = await api('/settings', { method: 'PUT', json: { activityGroupId: 'not-mine' } });
      expect(res.status).toBe(422);
      expect((await res.json()).data).toEqual({ code: 'unknown_league' });
    });

    it('PUT /settings is 400 without an activity group', async () => {
      expect((await api('/settings', { method: 'PUT', json: {} })).status).toBe(400);
    });
  });

  it('turns a refused refresh into needs_reconnect: 409 on use, and a reason on the status', async () => {
    fake.accessTtl = 60; // under the 2-minute window: every use refreshes
    await connect(browser);
    fake.revokeChain();

    const res = await api('/leagues/upstream');
    expect(res.status).toBe(409);
    expect((await res.json()).data).toEqual({ code: 'needs_reconnect' });
    expect(await (await api('/pokemon/connection')).json()).toMatchObject({
      status: 'needs_reconnect',
      reason: expect.stringMatching(/no longer accepts/),
      league: { id: 'group-1' },
    });

    expect((await connect(browser)).status).toBe(200);
    expect((await (await api('/pokemon/connection')).json()).status).toBe('connected');
  });

  it('disconnect revokes the refresh token at Pokémon and forgets it', async () => {
    await connect(browser);
    const issued = fake.liveRefreshToken();

    const res = await api('/pokemon/connection', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(fake.requests.find((r) => r.path === '/oauth2/revoke')?.form).toMatchObject({ token: issued, client_id: 'op-tools-app' });
    expect((await (await api('/pokemon/connection')).json()).status).toBe('not_connected');
  });
});

describe('Pokémon connection across a restart', () => {
  it('keeps the connection, and refreshes with the rotated token sealed under the persisted vault key', async () => {
    fake.accessTtl = 3599;
    const first = await bootApp();
    expect((await connect(first.browser)).status).toBe(200);
    const issued = fake.liveRefreshToken();
    await first.server.stop();

    const second = await bootApp(first.server.dataDir);
    try {
      expect((await (await second.browser.request('/api/pokemon/connection')).json()).status).toBe('connected');
      fake.requests.length = 0;
      expect((await second.browser.request('/api/leagues/upstream')).status).toBe(200);
      expect(fake.requests[0]?.form).toMatchObject({ grant_type: 'refresh_token', refresh_token: issued });
      expect(second.server.logs()).not.toMatch(/ory_rt_|eyJ/);
    } finally {
      await second.server.dispose();
    }
  });
});
