import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakePokemon, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, startServer } from './harness';

// Accepting invites and password reset links (ADR-0015 §6, §8), over HTTP against the real server and the Pokémon fake.
// The public routes take no session, answer every bad secret alike, and are limited per client before the body is read.

const OWNER = { username: 'organizer', password: 'correct horse' };
const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };
const SECRET = /^ppa_inv_[A-Za-z0-9_-]{43}$/;
const INVALID = "This link doesn't work. It may have expired, been used or been revoked.";

type Browser = ReturnType<typeof client>;

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const codeOf = async (res: Response) => (await json<{ data?: { code?: string } }>(res)).data?.code;

async function connect(browser: Browser, code = 'fresh') {
  const start = await browser.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL((await json<{ authorizeUrl: string }>(start)).authorizeUrl).searchParams.get('state');
  return browser.request('/api/pokemon/connect/complete', { method: 'POST', json: { url: `https://play-tools.pokemon.com/loggedIn?code=${code}&state=${state}` } });
}

describe('invites and reset links', () => {
  let server: TestServer;
  let owner: Browser;
  let db: Database.Database;

  async function start(env: Record<string, string> = {}) {
    server = await startServer({ env: { ...fake.env, TZ: 'America/Chicago', ...env } });
    owner = client(server.url);
    expect((await owner.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } })).status).toBe(200);
    db = new Database(join(server.dataDir, 'app.db'));
    db.pragma('busy_timeout = 5000');
  }

  async function mint(body: Record<string, unknown> = { send: 'copy' }) {
    const res = await owner.request('/api/professors/invites', { method: 'POST', json: body });
    expect(res.status, 'mint').toBe(201);
    return json<{ invite: { id: number }; secret: string; link: string | null }>(res);
  }

  const anonymous = () => client(server.url);
  const check = (secret: unknown, browser = anonymous()) => browser.request('/api/invites/check', { method: 'POST', json: { secret } });
  const accept = (body: Record<string, unknown>, browser = anonymous()) => browser.request('/api/invites/accept', { method: 'POST', json: body });

  /** A professor who accepted an invite (bound to `playerId` when given) and is signed in. */
  async function invited(username: string, opts: { playerId?: string } = {}) {
    const { secret } = await mint({ send: 'copy', ...(opts.playerId ? { playerId: opts.playerId } : {}) });
    const browser = anonymous();
    expect((await accept({ secret, username, password: 'water types' }, browser)).status).toBe(201);
    return browser;
  }

  afterEach(async () => {
    db?.close();
    expect(server.logs()).not.toMatch(/ppa_inv_[A-Za-z0-9_-]{5,}/);
    await server.dispose();
  });

  describe('with the default limits', () => {
    beforeEach(async () => {
      fake.requests.length = 0;
      fake.accounts.splice(1);
      fake.leagues = [CARD_SHOP];
      // These tests make more invite calls than the default 5 per 15 minutes; the limit has its own test below.
      await start({ NUXT_INVITE_RATE_LIMIT_MAX: '1000' });
      expect((await connect(owner)).status).toBe(200);
    });

    it('mints a link to copy that holds the secret once, and none without a site URL', async () => {
      const { invite, secret, link } = await mint({ label: 'Misty', send: 'copy' });
      expect(secret).toMatch(SECRET);
      expect(link).toBeNull();
      const listed = await (await owner.request('/api/professors')).text();
      expect(listed).toContain(`"id":${invite.id}`);
      expect(listed).not.toContain(secret);
    });

    it('describes the invite to anyone holding the secret', async () => {
      const { secret } = await mint({ label: 'Misty', send: 'copy' });
      const res = await check(secret);
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ kind: 'invite', label: 'Misty', leagueName: 'Card Shop', expiresAt: expect.any(String), username: null });
    });

    it('creates a professor, signs them in, and leaves them waiting to connect their own Pokémon account', async () => {
      const { invite, secret } = await mint();
      const browser = anonymous();

      const res = await accept({ secret, username: 'Misty', password: 'water types' }, browser);

      expect(res.status).toBe(201);
      expect(await json(res)).toEqual({ user: { id: expect.any(Number), username: 'misty' } });
      expect(browser.cookie).toMatch(/nuxt-session=/);
      expect(await json(await browser.request('/api/settings'))).toEqual({ access: { username: 'misty', role: 'professor', member: false, waiting: 'no_connection' } });
      expect(db.prepare('select accepted_user_id from app_invite where id = ?').get(invite.id)).toEqual({ accepted_user_id: expect.any(Number) });
      expect((await check(secret)).status).toBe(404);
    });

    it.each([
      ['active', null],
      ['removed', 1],
    ] as const)('refuses a username an %s user has, and leaves the invite open', async (_state, removedAt) => {
      db.prepare("insert into app_user (username, password_hash, role, removed_at, created_at) values ('misty', 'h', 'professor', ?, 1)").run(removedAt);
      const { secret } = await mint();
      const res = await accept({ secret, username: 'misty', password: 'water types' });
      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe('username_taken');
      expect((await check(secret)).status).toBe(200);
    });

    it('answers every unusable secret the same way, from both routes', async () => {
      const used = await mint();
      await accept({ secret: used.secret, username: 'misty', password: 'water types' });
      const revoked = await mint();
      expect((await owner.request(`/api/professors/invites/${revoked.invite.id}`, { method: 'DELETE' })).status).toBe(204);
      const expired = await mint();
      db.prepare('update app_invite set expires_at = 1 where id = ?').run(expired.invite.id);

      for (const secret of [`ppa_inv_${'A'.repeat(43)}`, 'abc', used.secret, revoked.secret, expired.secret]) {
        for (const res of [await check(secret), await accept({ secret, username: 'brock', password: 'rock types' })]) {
          expect(res.status).toBe(404);
          expect(await json(res)).toMatchObject({ message: INVALID, data: { code: 'invite_invalid' } });
        }
      }
    });

    it('refuses a signed-in browser before reading the invite', async () => {
      const { secret } = await mint();
      for (const res of [await check(secret, owner), await accept({ secret, username: 'misty', password: 'water types' }, owner)]) {
        expect(res.status).toBe(409);
        expect(await codeOf(res)).toBe('already_signed_in');
      }
      expect((await check(secret)).status).toBe(200);
    });

    it.each([
      ['no body', {}],
      ['a 201-character secret', { secret: 'x'.repeat(201) }],
    ])('rejects %s on check with 400', async (_what, body) => {
      expect((await anonymous().request('/api/invites/check', { method: 'POST', json: body })).status).toBe(400);
    });

    it('holds accept to the same username and password rules as setup', async () => {
      const { secret } = await mint();
      for (const [body, status] of [
        [{ secret, username: 'misty', password: 'x'.repeat(7) }, 400],
        [{ secret, username: 'misty', password: 'x'.repeat(257) }, 400],
        [{ secret, username: 'ms', password: 'water types' }, 400],
        [{ secret, username: 'bad name!', password: 'water types' }, 400],
        [{ secret, password: 'water types' }, 400],
        [{ secret, username: 'misty', password: 'x'.repeat(8) }, 201],
      ] as const) {
        expect((await accept(body)).status, JSON.stringify(body).slice(0, 60)).toBe(status);
      }
    });

    it('lets a bound professor connect only the Pokémon account the invite names', async () => {
      const misty = await invited('misty', { playerId: '0000333' });
      const other = fake.addAccount({ playerId: '0000999', name: 'Someone', leagues: [CARD_SHOP] });
      const revokesBefore = fake.requests.filter((r) => r.path === '/oauth2/revoke').length;

      const refused = await connect(misty, other.code);
      expect(refused.status).toBe(409);
      expect(await codeOf(refused)).toBe('invite_player_mismatch');
      expect(fake.requests.filter((r) => r.path === '/oauth2/revoke').length).toBe(revokesBefore + 1);
      expect(db.prepare("select count(*) as n from pokemon_connection where professor_player_id = '0000999'").get()).toEqual({ n: 0 });

      const own = fake.addAccount({ playerId: '0000333', name: 'Misty', leagues: [CARD_SHOP] });
      expect((await connect(misty, own.code)).status).toBe(200);
    });

    it("sets a professor's new password with a reset link, and holds them until they connect their own account again", async () => {
      const misty = await invited('misty');
      const account = fake.addAccount({ playerId: '0000333', name: 'Misty', leagues: [CARD_SHOP] });
      expect((await connect(misty, account.code)).status).toBe(200);
      const userId = (db.prepare("select id from app_user where username = 'misty'").get() as { id: number }).id;

      const minted = await owner.request(`/api/professors/${userId}/reset-link`, { method: 'POST', json: { send: 'copy' } });
      expect(minted.status).toBe(201);
      const { secret } = await json<{ secret: string }>(minted);
      expect(await json(await check(secret))).toMatchObject({ kind: 'reset', username: 'misty' });

      const browser = anonymous();
      expect((await accept({ secret, password: 'new password' }, browser)).status).toBe(201);
      const login = (password: string) => anonymous().request('/api/auth/login', { method: 'POST', json: { username: 'misty', password } });
      expect((await login('water types')).status).toBe(401);
      expect((await login('new password')).status).toBe(200);

      expect(await json(await browser.request('/api/settings'))).toMatchObject({ access: { member: false, waiting: 'reverify_required' } });
      const held = await browser.request('/api/regulars');
      expect(held.status).toBe(403);
      expect(await codeOf(held)).toBe('reverify_required');

      expect((await connect(browser, account.code)).status).toBe(200);
      expect((await browser.request('/api/regulars')).status).toBe(200);
    });
  });

  describe('with small invite limits', () => {
    beforeEach(async () => {
      await start({ NUXT_INVITE_RATE_LIMIT_MAX: '2' });
    });

    it('limits each route per client, before reading the body, and counts the two routes apart', async () => {
      const browser = anonymous();
      expect((await check('abc', browser)).status).toBe(404);
      expect((await check('abc', browser)).status).toBe(404);
      const limited = await browser.request('/api/invites/check', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

      expect((await accept({ secret: 'abc', username: 'misty', password: 'water types' }, browser)).status).toBe(404);
      expect((await accept({ secret: 'abc', username: 'misty', password: 'water types' }, browser)).status).toBe(404);
      expect((await accept({ secret: 'abc', username: 'misty', password: 'water types' }, browser)).status).toBe(429);
    });
  });
});
