import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTokenVault } from '../../server/modules/pokemon/vault/vault';
import { FAKE_PLAYER_ID, type FakePokemon, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };
const VAULT_KEY = randomBytes(32).toString('base64');
const BROCK = { playerId: '0000222', name: 'Brock Harrison' };
const GAME_DEN = { guid: 'group-2', display_id: 'L7000', display_name: 'Game Den', canSubmit: true };
/** The default account's league (`group-1`), as Brock's account names it. */
const CARD_SHOP_AS_BROCK = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop (Brock)', canSubmit: true };

// The response contracts, strict so an unexpected key (a token, say) fails the test.
const ProfessorConnection = z
  .object({
    professorPlayerId: z.string().nullable(),
    professorName: z.string().nullable(),
    professorFullName: z.string().nullable(),
    status: z.enum(['connected', 'needs_reconnect']),
    reason: z.string().nullable(),
    connectedAt: z.string().datetime(),
    lastRefreshedAt: z.string().datetime(),
    submitsForLeague: z.boolean(),
  })
  .strict();
const LeagueBinding = z
  .object({ professorPlayerId: z.string(), activityGroupId: z.string(), displayName: z.string(), displayId: z.string().nullable(), canSubmit: z.boolean() })
  .strict();
const ConnectionsResponse = z.object({ connections: z.array(ProfessorConnection), league: LeagueBinding.nullable() }).strict();
const ConnectCompleteResponse = z.object({ connection: ProfessorConnection, outcome: z.enum(['added', 'reconnected']) }).strict();
const UpstreamLeagues = z
  .object({
    leagues: z.array(z.object({ activityGroupId: z.string(), displayName: z.string(), displayId: z.string().nullable(), canSubmit: z.boolean() }).strict()),
    selectedId: z.string().nullable(),
    excluded: z.array(z.object({ playerId: z.string().nullable(), name: z.string().nullable() }).strict()),
  })
  .strict();

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

const env = () => ({ ...fake.env, NUXT_TOKEN_VAULT_KEY: VAULT_KEY });

async function bootApp(dataDir?: string): Promise<{ server: TestServer; browser: ReturnType<typeof client> }> {
  const server = await startServer({ env: env(), dataDir });
  const browser = client(server.url);
  if (!dataDir) {
    const res = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } });
    expect(res.status).toBe(200);
  } else {
    expect((await browser.request('/api/auth/login', { method: 'POST', json: OWNER })).status).toBe(200);
  }
  return { server, browser };
}

/** Starts a connect and pastes back the URL play-tools would show after logging in with `code`. */
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

/** Every response body the test read, for the secret sweep. */
const bodies: string[] = [];

describe('Pokémon connections API', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;
  async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
    const res = await browser.request(`/api${path}`, init);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
  }
  const connections = async () => ConnectionsResponse.parse((await api('/pokemon/connections')).json());

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.accessTtl = 3599;
    fake.accounts.splice(1);
    fake.reuseRevocations.length = 0;
    fake.leagues = [{ guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true }];
    bodies.length = 0;
    ({ server, browser } = await bootApp());
  });
  afterEach(async () => {
    const secrets = fake.issuedTokens();
    for (const text of [...bodies, server.logs()]) for (const s of secrets) expect(text).not.toContain(s);
    expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
    expect(fake.reuseRevocations).toEqual([]);
    await server.dispose();
  });

  describe('auth', () => {
    const routes = [
      ['GET', '/api/pokemon/connections'],
      ['DELETE', `/api/pokemon/connections/${FAKE_PLAYER_ID}`],
      ['PATCH', `/api/pokemon/connections/${FAKE_PLAYER_ID}`],
      ['POST', '/api/pokemon/connect/start'],
      ['POST', '/api/pokemon/connect/complete'],
      ['GET', '/api/leagues/upstream?professor=1'],
      ['PUT', '/api/settings'],
    ] as const;

    it.each(routes)('%s %s is 401 without a session, before any validation', async (method, path) => {
      const res = await client(server.url).request(path, { method, json: method === 'GET' || method === 'DELETE' ? undefined : {} });
      expect(res.status).toBe(401);
      expect(fake.requests).toEqual([]);
    });

    it.each(routes)('%s %s is 401 with a tampered session cookie', async (method, path) => {
      const res = await fetch(`${server.url}${path}`, {
        method,
        headers: { cookie: `${browser.cookie.split('=')[0]}=Fe26.2**forged**`, 'content-type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      });
      expect(res.status).toBe(401);
    });
  });

  it('lists nobody on a fresh install', async () => {
    expect(await connections()).toEqual({ connections: [], league: null });
  });

  it('the single-connection routes are gone', async () => {
    expect((await api('/pokemon/connection')).status).toBe(404);
    expect((await api('/pokemon/connection', { method: 'DELETE' })).status).toBe(404);
  });

  describe('POST /pokemon/connect/start', () => {
    it("returns Pokémon's login URL with a PKCE challenge and state, and calls nothing upstream", async () => {
      const res = await api('/pokemon/connect/start', { method: 'POST', json: {} });
      expect(res.status).toBe(200);
      const body = res.json() as { authorizeUrl: string; expiresAt: string };
      const url = new URL(body.authorizeUrl);
      expect(url.origin + url.pathname).toBe(`${fake.url}/oauth2/auth`);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('redirect_uri')).toBe('https://play-tools.pokemon.com/loggedIn');
      expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
      expect(fake.requests).toEqual([]);
    });
  });

  describe('POST /pokemon/connect/complete', () => {
    it('adds the professor, binds their only league, and never returns a token', async () => {
      const res = await connect(browser);
      const text = await res.text();
      bodies.push(text);

      expect(res.status).toBe(200);
      expect(ConnectCompleteResponse.parse(JSON.parse(text))).toEqual({
        outcome: 'added',
        connection: {
          professorPlayerId: FAKE_PLAYER_ID,
          professorName: null,
          professorFullName: null,
          status: 'connected',
          reason: null,
          connectedAt: expect.any(String),
          lastRefreshedAt: expect.any(String),
          submitsForLeague: true,
        },
      });
      expect(fake.requests.find((r) => r.form?.grant_type === 'authorization_code')?.form).toMatchObject({
        code: 'fresh-code',
        code_verifier: expect.stringMatching(/^[\w-]{43}$/),
      });
      expect((await connections()).league).toEqual({
        professorPlayerId: FAKE_PLAYER_ID,
        activityGroupId: 'group-1',
        displayName: 'Card Shop',
        displayId: 'L5012',
        canSubmit: true,
      });
    });

    it("adds a second professor next to the first, keeping the first one's league", async () => {
      await connect(browser);
      const brock = fake.addAccount({ ...BROCK, leagues: [GAME_DEN] });

      const res = await connect(browser, brock.code);
      const body = ConnectCompleteResponse.parse(await res.json());

      expect(body).toMatchObject({ outcome: 'added', connection: { professorPlayerId: '0000222', submitsForLeague: false } });
      const list = await connections();
      expect(list.connections.map((c) => [c.professorPlayerId, c.submitsForLeague])).toEqual(
        expect.arrayContaining([
          [FAKE_PLAYER_ID, true],
          ['0000222', false],
        ]),
      );
      expect(list.league?.professorPlayerId).toBe(FAKE_PLAYER_ID);
    });

    it.each([
      ['missing', {}],
      ['empty', { url: '' }],
      ['too long', { url: `https://play-tools.pokemon.com/loggedIn?code=${'a'.repeat(4097)}` }],
    ])('is 400 when the url is %s', async (_l, json) => {
      expect((await api('/pokemon/connect/complete', { method: 'POST', json })).status).toBe(400);
    });

    it('is 415 for a body that is not JSON, like every JSON route', async () => {
      const res = await browser.request('/api/pokemon/connect/complete', { method: 'POST', body: 'url=x', headers: { 'content-type': 'text/plain' } });
      expect(res.status).toBe(415);
    });

    it('is 400 invalid_url for something that is not the play-tools address', async () => {
      await api('/pokemon/connect/start', { method: 'POST', json: {} });
      const res = await api('/pokemon/connect/complete', { method: 'POST', json: { url: 'https://evil.example/loggedIn?code=a&state=b' } });
      expect(res.status).toBe(400);
      expect(res.json().data).toEqual({ code: 'invalid_url' });
    });

    it('is 400 unknown_attempt for a state this app never issued, or one already used, without calling Pokémon again', async () => {
      const forged = await api('/pokemon/connect/complete', { method: 'POST', json: { url: 'https://play-tools.pokemon.com/loggedIn?code=a&state=forged' } });
      expect(forged.status).toBe(400);
      expect(forged.json().data).toEqual({ code: 'unknown_attempt' });
      expect(fake.requests).toEqual([]);

      const start = await api('/pokemon/connect/start', { method: 'POST', json: {} });
      const state = new URL(start.json().authorizeUrl as string).searchParams.get('state');
      const pasted = { url: `https://play-tools.pokemon.com/loggedIn?code=once&state=${state}` };
      expect((await api('/pokemon/connect/complete', { method: 'POST', json: pasted })).status).toBe(200);
      const replay = await api('/pokemon/connect/complete', { method: 'POST', json: pasted });
      expect(replay.status).toBe(400);
      expect(replay.json().data).toEqual({ code: 'unknown_attempt' });
      expect((await connections()).connections).toHaveLength(1);
    });

    it('is 400 code_rejected when Pokémon refuses the code, and stores nobody', async () => {
      const res = await connect(browser, 'used');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.data).toEqual({ code: 'code_rejected' });
      expect(body.message).toMatch(/already been used/);
      expect((await connections()).connections).toEqual([]);
    });

    it('is 502 upstream_unavailable when Pokémon fails while identifying the professor, and stores nobody', async () => {
      fake.failOnce.set(`/services/core/users/${fake.accounts[0]!.sub}/activity_groups/`, 503);
      const res = await connect(browser);
      expect(res.status).toBe(502);
      expect((await res.json()).data).toEqual({ code: 'upstream_unavailable' });
      expect((await connections()).connections).toEqual([]);
    });

    it('is 409 connection_limit for an eleventh professor, and still reconnects a known one', async () => {
      for (let i = 1; i <= 9; i++) fake.addAccount({ playerId: String(5000 + i), name: `Prof ${i}` });
      expect((await connect(browser)).status).toBe(200);
      for (const a of fake.accounts.slice(1)) expect((await connect(browser, a.code)).status).toBe(200);

      const extra = fake.addAccount({ playerId: '6000', name: 'One Too Many' });
      const res = await connect(browser, extra.code);
      expect(res.status).toBe(409);
      expect((await res.json()).data).toEqual({ code: 'connection_limit' });
      expect((await connections()).connections).toHaveLength(10);

      const again = ConnectCompleteResponse.parse(await (await connect(browser, fake.accounts[3]!.code)).json());
      expect(again.outcome).toBe('reconnected');
    });

    it('answers GET /pokemon/connections at 10 professors without calling Pokémon', async () => {
      for (let i = 1; i <= 9; i++) fake.addAccount({ playerId: String(5000 + i), name: `Prof ${i}` });
      await connect(browser);
      for (const a of fake.accounts.slice(1)) await connect(browser, a.code);
      fake.requests.length = 0;

      expect((await connections()).connections).toHaveLength(10);
      expect(fake.requests).toEqual([]);
    });
  });

  describe('GET /leagues/upstream', () => {
    it.each([
      ['missing', ''],
      ['not digits', '?professor=1%20OR%201%3D1'],
      ['13 digits', '?professor=1234567890123'],
      ['given twice', '?professor=1&professor=2'],
    ])('is 400 when the professor is %s', async (_l, query) => {
      expect((await api(`/leagues/upstream${query}`)).status).toBe(400);
    });

    it('is 404 connection_not_found for a professor nobody connected', async () => {
      const res = await api('/leagues/upstream?professor=999');
      expect(res.status).toBe(404);
      expect(res.json().data).toEqual({ code: 'connection_not_found' });
    });

    it('lists only the leagues every connected professor shares, as that professor names them, each read as its own professor', async () => {
      await connect(browser);
      const brock = fake.addAccount({ ...BROCK, leagues: [GAME_DEN, CARD_SHOP_AS_BROCK] });
      await connect(browser, brock.code);
      fake.requests.length = 0;

      const res = await api('/leagues/upstream?professor=0000222');
      expect(res.status).toBe(200);
      expect(UpstreamLeagues.parse(res.json())).toEqual({
        leagues: [{ activityGroupId: 'group-1', displayName: 'Card Shop (Brock)', displayId: 'L5012', canSubmit: true }],
        selectedId: null,
        excluded: [],
      });
      const reads = fake.requests.filter((r) => r.path.endsWith('/activity_groups/'));
      expect(reads.map((r) => [r.path, r.as]).sort()).toEqual(
        [
          [`/services/core/users/${fake.accounts[0]!.sub}/activity_groups/`, FAKE_PLAYER_ID],
          [`/services/core/users/${brock.sub}/activity_groups/`, '0000222'],
        ].sort(),
      );
    });

    it('leaves out a professor whose login was refused, naming them', async () => {
      await connect(browser);
      const brock = fake.addAccount({ ...BROCK, leagues: [GAME_DEN] });
      // Brock's access token is short-lived, so his next use refreshes, and Hydra refuses it.
      fake.accessTtl = 60;
      await connect(browser, brock.code);
      fake.revokeChain('0000222');

      const res = await api(`/leagues/upstream?professor=${FAKE_PLAYER_ID}`);
      expect(res.status).toBe(200);
      expect(UpstreamLeagues.parse(res.json())).toEqual({
        leagues: [{ activityGroupId: 'group-1', displayName: 'Card Shop', displayId: 'L5012', canSubmit: true }],
        selectedId: 'group-1',
        excluded: [{ playerId: '0000222', name: null }],
      });
    });

    it("is 502 unavailable when another professor's leagues can't be read, so nothing is chosen from a partial list", async () => {
      await connect(browser);
      const brock = fake.addAccount({ ...BROCK, leagues: [GAME_DEN, CARD_SHOP_AS_BROCK] });
      await connect(browser, brock.code);
      fake.failOnce.set(`/services/core/users/${brock.sub}/activity_groups/@0000222`, 503);

      const res = await api(`/leagues/upstream?professor=${FAKE_PLAYER_ID}`);
      expect(res.status).toBe(502);
      expect(res.json().data).toEqual({ code: 'unavailable' });
    });
  });

  describe('PUT /settings (the submitting professor)', () => {
    beforeEach(async () => {
      await connect(browser);
      const brock = fake.addAccount({ ...BROCK, leagues: [GAME_DEN, CARD_SHOP_AS_BROCK] });
      await connect(browser, brock.code);
    });

    it('binds the league to the chosen professor and a league every professor shares', async () => {
      const put = await api('/settings', { method: 'PUT', json: { professorPlayerId: '0000222', activityGroupId: 'group-1' } });
      expect(put.status).toBe(200);
      expect(LeagueBinding.parse(put.json().connection)).toEqual({
        professorPlayerId: '0000222',
        activityGroupId: 'group-1',
        displayName: 'Card Shop (Brock)',
        displayId: 'L5012',
        canSubmit: true,
      });
      const list = await connections();
      expect(list.connections.find((c) => c.professorPlayerId === '0000222')?.submitsForLeague).toBe(true);
    });

    it.each([
      ["that professor can't see", 'group-9'],
      ['another professor lacks', 'group-2'],
    ])("is 404 league_not_found for a league %s, and keeps the current binding", async (_l, activityGroupId) => {
      const res = await api('/settings', { method: 'PUT', json: { professorPlayerId: '0000222', activityGroupId } });
      expect(res.status).toBe(404);
      expect(res.json().data).toEqual({ code: 'league_not_found' });
      expect((await connections()).league).toMatchObject({ professorPlayerId: FAKE_PLAYER_ID, activityGroupId: 'group-1' });
    });

    it('is 404 connection_not_found for a professor nobody connected', async () => {
      const res = await api('/settings', { method: 'PUT', json: { professorPlayerId: '999', activityGroupId: 'group-1' } });
      expect(res.status).toBe(404);
      expect(res.json().data).toEqual({ code: 'connection_not_found' });
    });

    it.each([
      ['only the league', { activityGroupId: 'group-1' }],
      ['only the professor', { professorPlayerId: '0000222' }],
      ['a numeric professor', { professorPlayerId: 222, activityGroupId: 'group-2' }],
      ['a professor that is not digits', { professorPlayerId: 'abc', activityGroupId: 'group-2' }],
      ['null', { professorPlayerId: null, activityGroupId: 'group-2' }],
    ])('is 400 for %s', async (_l, json) => {
      expect((await api('/settings', { method: 'PUT', json })).status).toBe(400);
    });

    it('changes nothing for an empty body', async () => {
      const res = await api('/settings', { method: 'PUT', json: {} });
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({});
      expect((await connections()).league?.professorPlayerId).toBe(FAKE_PLAYER_ID);
    });
  });

  describe('PATCH /pokemon/connections/:playerId (display name)', () => {
    const rename = (id: string, json: unknown) => api(`/pokemon/connections/${id}`, { method: 'PATCH', json });

    beforeEach(async () => {
      const brock = fake.addAccount({ ...BROCK, leagues: [GAME_DEN] });
      await connect(browser, brock.code);
    });

    it('sets a trimmed display name and lists it, without sending it to Pokémon', async () => {
      fake.requests.length = 0;
      const res = await rename('0000222', { name: '  Brock Harrison  ' });
      expect(res.status).toBe(200);
      expect(ProfessorConnection.parse(res.json())).toMatchObject({ professorPlayerId: '0000222', professorName: 'Brock Harrison' });
      expect((await connections()).connections[0]).toMatchObject({ professorPlayerId: '0000222', professorName: 'Brock Harrison' });
      expect(fake.requests).toEqual([]);
    });

    it('never sends the name to Pokémon later either: not on reconnect, league discovery or keep-alive', async () => {
      await rename('0000222', { name: 'Brock Harrison' });
      await connect(browser, fake.accounts[1]!.code);
      await api('/leagues/upstream?professor=0000222');
      const sent = fake.requests.map((r) => JSON.stringify(r));
      expect(sent.filter((r) => r.includes('Brock Harrison'))).toEqual([]);
      expect((await connections()).connections[0]?.professorName).toBe('Brock Harrison');
    });

    it.each([
      ['an empty string', { name: '' }],
      ['null', { name: null }],
    ])('clears the name with %s', async (_l, json) => {
      await rename('0000222', { name: 'Brock Harrison' });
      const res = await rename('0000222', json);
      expect(res.status).toBe(200);
      expect(res.json().professorName).toBeNull();
    });

    it('takes 60 characters', async () => {
      expect((await rename('0000222', { name: 'a'.repeat(60) })).status).toBe(200);
    });

    it.each([
      ['61 characters', { name: 'a'.repeat(61) }],
      ['a control character', { name: 'Brock\u0000' }],
      ['a number', { name: 42 }],
      ['neither name', {}],
    ])('is 400 for %s', async (_l, json) => {
      expect((await rename('0000222', json)).status).toBe(400);
      expect((await connections()).connections[0]?.professorName).toBeNull();
    });

    it('is 400 for a player id that is not digits, and 404 connection_not_found for an unknown professor', async () => {
      expect((await rename('abc', { name: 'X' })).status).toBe(400);
      const res = await rename('999', { name: 'X' });
      expect(res.status).toBe(404);
      expect(res.json().data).toEqual({ code: 'connection_not_found' });
    });
  
    describe('the full name for TDFs', () => {
      const brock = async () => (await connections()).connections[0]!;

      it('sets a trimmed full name on its own, keeping the display name, without sending it to Pokémon', async () => {
        await rename('0000222', { name: 'Brock' });
        fake.requests.length = 0;
        const res = await rename('0000222', { fullName: '  Brock Harrison  ' });
        expect(res.status).toBe(200);
        expect(ProfessorConnection.parse(res.json())).toMatchObject({ professorName: 'Brock', professorFullName: 'Brock Harrison' });
        expect(await brock()).toMatchObject({ professorName: 'Brock', professorFullName: 'Brock Harrison' });
        expect(fake.requests).toEqual([]);
      });

      it('keeps the full name when only the display name changes', async () => {
        await rename('0000222', { name: 'Brock', fullName: 'Brock Harrison' });
        expect((await rename('0000222', { name: 'Brocko' })).json()).toMatchObject({ professorName: 'Brocko', professorFullName: 'Brock Harrison' });
      });

      it.each([
        ['an empty string', { fullName: '' }],
        ['null', { fullName: null }],
      ])('clears the full name with %s, keeping the display name', async (_l, json) => {
        await rename('0000222', { name: 'Brock', fullName: 'Brock Harrison' });
        const res = await rename('0000222', json);
        expect(res.status).toBe(200);
        expect(res.json()).toMatchObject({ professorName: 'Brock', professorFullName: null });
      });

      it('takes 100 characters, and markup-looking text as it is', async () => {
        expect((await rename('0000222', { fullName: 'a'.repeat(100) })).status).toBe(200);
        expect((await rename('0000222', { fullName: "O'Brien & <Co>" })).json().professorFullName).toBe("O'Brien & <Co>");
      });

      it.each([
        ['101 characters', { fullName: 'a'.repeat(101) }],
        ['a control character', { fullName: 'Brock\u0000' }],
        ['a newline', { fullName: 'Brock\nHarrison' }],
        ['a number', { fullName: 42 }],
        ['an invalid display name beside it', { name: 'a'.repeat(61), fullName: 'Brock Harrison' }],
      ])('is 400 for %s, changing neither name', async (_l, json) => {
        await rename('0000222', { name: 'Brock', fullName: 'Brock H.' });
        expect((await rename('0000222', json)).status).toBe(400);
        expect(await brock()).toMatchObject({ professorName: 'Brock', professorFullName: 'Brock H.' });
      });

      it('is 404 connection_not_found for an unknown professor', async () => {
        const res = await rename('999', { fullName: 'Nobody' });
        expect(res.status).toBe(404);
        expect(res.json().data).toEqual({ code: 'connection_not_found' });
      });

      it('keeps it across a reconnect and league discovery, and sends it to Pokémon on neither', async () => {
        await rename('0000222', { fullName: 'Brock Harrison' });
        await connect(browser, fake.accounts[1]!.code);
        await api('/leagues/upstream?professor=0000222');
        expect(fake.requests.map((r) => JSON.stringify(r)).filter((r) => r.includes('Brock Harrison'))).toEqual([]);
        expect((await brock()).professorFullName).toBe('Brock Harrison');
      });
    });
  });

  describe('DELETE /pokemon/connections/:playerId', () => {
    it.each([
      ['not digits', 'abc'],
      ['13 digits', '1234567890123'],
    ])('is 400 for a player id that is %s', async (_l, id) => {
      expect((await api(`/pokemon/connections/${id}`, { method: 'DELETE' })).status).toBe(400);
    });

    it('is 404 connection_not_found for a professor nobody connected', async () => {
      const res = await api('/pokemon/connections/999', { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect(res.json().data).toEqual({ code: 'connection_not_found' });
    });

    it("revokes only that professor's token, and the league forgets them if they submitted for it", async () => {
      await connect(browser);
      const brock = fake.addAccount({ ...BROCK, leagues: [GAME_DEN] });
      await connect(browser, brock.code);
      const firstToken = fake.liveRefreshToken();

      const res = await api(`/pokemon/connections/${FAKE_PLAYER_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ revoked: true });
      expect(fake.requests.filter((r) => r.path === '/oauth2/revoke').map((r) => r.form?.token)).toEqual([firstToken]);
      const list = await connections();
      expect(list.connections.map((c) => c.professorPlayerId)).toEqual(['0000222']);
      expect(list.league).toBeNull();
    });

    it('keeps leading zeros in the player id', async () => {
      const brock = fake.addAccount({ ...BROCK, leagues: [GAME_DEN] });
      await connect(browser, brock.code);
      expect((await api('/pokemon/connections/0000222', { method: 'DELETE' })).status).toBe(200);
      expect((await connections()).connections).toEqual([]);
    });
  });

  it("turns one professor's refused refresh into needs_reconnect for them only", async () => {
    fake.accessTtl = 60; // under the 2-minute window: every use refreshes
    await connect(browser);
    const brock = fake.addAccount({ ...BROCK, leagues: [GAME_DEN] });
    await connect(browser, brock.code);
    fake.revokeChain(FAKE_PLAYER_ID);

    const res = await api(`/leagues/upstream?professor=${FAKE_PLAYER_ID}`);
    expect(res.status).toBe(409);
    expect(res.json().data).toEqual({ code: 'needs_reconnect' });
    expect((await api('/leagues/upstream?professor=0000222')).status).toBe(200);

    const list = await connections();
    expect(list.connections.find((c) => c.professorPlayerId === FAKE_PLAYER_ID)).toMatchObject({
      status: 'needs_reconnect',
      reason: expect.stringMatching(/no longer accepts/),
    });
    expect(list.connections.find((c) => c.professorPlayerId === '0000222')?.status).toBe('connected');

    const again = ConnectCompleteResponse.parse(await (await connect(browser)).json());
    expect(again).toMatchObject({ outcome: 'reconnected', connection: { status: 'connected', submitsForLeague: true } });
  });
});

describe('Pokémon connections across a restart', () => {
  it('keeps both professors, each refreshing with their own rotated token', async () => {
    fake.accounts.splice(1);
    fake.accessTtl = 3599;
    const first = await bootApp();
    expect((await connect(first.browser)).status).toBe(200);
    const brock = fake.addAccount({ ...BROCK, leagues: [GAME_DEN] });
    expect((await connect(first.browser, brock.code)).status).toBe(200);
    const issued = { olive: fake.liveRefreshToken(), brock: fake.liveRefreshToken('0000222') };
    await first.server.stop();

    const second = await bootApp(first.server.dataDir);
    try {
      expect(ConnectionsResponse.parse(await (await second.browser.request('/api/pokemon/connections')).json()).connections).toHaveLength(2);
      fake.requests.length = 0;
      expect((await second.browser.request(`/api/leagues/upstream?professor=${FAKE_PLAYER_ID}`)).status).toBe(200);
      expect((await second.browser.request('/api/leagues/upstream?professor=0000222')).status).toBe(200);
      const refreshes = fake.requests.filter((r) => r.form?.grant_type === 'refresh_token').map((r) => r.form?.refresh_token);
      expect(refreshes).toEqual([issued.olive, issued.brock]);
      expect(fake.reuseRevocations).toEqual([]);
      expect(second.server.logs()).not.toMatch(/ory_rt_|eyJ/);
    } finally {
      await second.server.dispose();
    }
  });
});

describe('upgrading an install that had one Pokémon connection (ADR-0008)', () => {
  const MIGRATIONS = resolve('server/db/migrations');

  /** A data dir whose database stops at migration 0008, with the login from `from` and a v1 connection. */
  function v1DataDir(from: string, refreshToken: string, sub: string): string {
    const user = new Database(join(from, 'app.db'), { readonly: true }).prepare('select username, password_hash from app_user').get() as {
      username: string;
      password_hash: string;
    };
    const dir = mkdtempSync(join(tmpdir(), 'ppa-v1-'));
    const migrations = mkdtempSync(join(tmpdir(), 'ppa-v1-migrations-'));
    cpSync(MIGRATIONS, migrations, { recursive: true });
    const journalPath = join(migrations, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string; idx: number }[] };
    journal.entries = journal.entries.filter((e) => e.idx <= 8);
    writeFileSync(journalPath, JSON.stringify(journal));

    // Migrations 0000–0008, with drizzle's own bookkeeping, so the app applies only 0009 on boot.
    const sqlite = new Database(join(dir, 'app.db'));
    migrate(drizzle(sqlite), { migrationsFolder: migrations });
    sqlite.prepare('insert into app_user (username, password_hash, created_at) values (?, ?, ?)').run(user.username, user.password_hash, 1760000000);
    sqlite
      .prepare(
        `insert into pokemon_connection (league_id, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at,
           activity_group_id, activity_group_name, activity_group_display_id, activity_group_can_submit)
         values ('default', ?, ?, 'connected', 1760000000, 1760000000, 'group-1', 'Card Shop', 'L5012', 1)`,
      )
      .run(sub, createTokenVault(VAULT_KEY).encrypt(refreshToken, 'default'));
    sqlite.close();
    return dir;
  }

  it('keeps the connection and its league without a reconnect, and learns the professor from Pokémon', async () => {
    fake.accounts.splice(1);
    fake.reuseRevocations.length = 0;
    const exchange = await fetch(`${fake.url}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'op-tools-app', code: 'v1-login', code_verifier: 'v' }),
    });
    const { refresh_token: v1Token } = (await exchange.json()) as { refresh_token: string };

    const login = await bootApp();
    await login.server.stop();
    const dataDir = v1DataDir(login.server.dataDir, v1Token, fake.accounts[0]!.sub);

    const upgraded = await bootApp(dataDir);
    try {
      let list = ConnectionsResponse.parse(await (await upgraded.browser.request('/api/pokemon/connections')).json());
      for (let i = 0; i < 50 && list.connections[0]?.professorPlayerId === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        list = ConnectionsResponse.parse(await (await upgraded.browser.request('/api/pokemon/connections')).json());
      }
      expect(list.connections).toEqual([expect.objectContaining({ professorPlayerId: FAKE_PLAYER_ID, status: 'connected', submitsForLeague: true })]);
      expect(list.league).toMatchObject({ professorPlayerId: FAKE_PLAYER_ID, activityGroupId: 'group-1' });
      expect(fake.requests.filter((r) => r.form?.grant_type === 'refresh_token').map((r) => r.form?.refresh_token)).toContain(v1Token);
      expect(fake.reuseRevocations).toEqual([]);
      expect(upgraded.server.logs()).not.toContain(v1Token);
    } finally {
      await upgraded.server.dispose();
      await login.server.dispose();
    }
  });
});

