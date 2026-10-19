import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakePokemon, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, startServer } from './harness';

// Settings → Professors (ADR-0015 §8): the owner lists, revokes and removes, over HTTP against the real server.

const OWNER = { username: 'organizer', password: 'correct horse' };
const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };

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

describe('managing professors', () => {
  let server: TestServer;
  let owner: Browser;
  let db: Database.Database;

  async function mint(body: Record<string, unknown> = { send: 'copy' }) {
    return owner.request('/api/professors/invites', { method: 'POST', json: body });
  }

  /** A member professor who joined through an invite and connected `playerId`. */
  async function member(username: string, playerId: string) {
    const { secret } = await json<{ secret: string }>(await mint());
    const browser = client(server.url);
    expect((await browser.request('/api/invites/accept', { method: 'POST', json: { secret, username, password: 'water types' } })).status).toBe(201);
    const account = fake.addAccount({ playerId, name: username, leagues: [CARD_SHOP] });
    expect((await connect(browser, account.code)).status).toBe(200);
    const userId = (db.prepare('select id from app_user where username = ?').get(username) as { id: number }).id;
    return { browser, userId };
  }

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.accounts.splice(1);
    fake.leagues = [CARD_SHOP];
    server = await startServer({ env: { ...fake.env, TZ: 'America/Chicago', NUXT_INVITE_RATE_LIMIT_MAX: '1000' } });
    owner = client(server.url);
    expect((await owner.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } })).status).toBe(200);
    expect((await connect(owner)).status).toBe(200);
    db = new Database(join(server.dataDir, 'app.db'));
    db.pragma('busy_timeout = 5000');
  });
  afterEach(async () => {
    db.close();
    await server.dispose();
  });

  it('lists professors with their connection, open invites, the seats and Genie, with no secret, hash or token', async () => {
    await member('misty', '0000333');
    await json(await mint({ label: 'Brock', send: 'copy' }));

    const res = await owner.request('/api/professors');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.clone().text();
    expect(text).not.toMatch(/ppa_inv_[A-Za-z0-9_-]{5,}|secret_hash|password|ory_rt_|ciphertext/);
    expect(await json(res)).toEqual({
      professors: [
        {
          userId: expect.any(Number),
          username: 'misty',
          createdAt: expect.any(String),
          lastSignInAt: expect.any(String),
          reverifyRequired: false,
          connection: { playerId: '0000333', name: null, status: 'connected', membership: 'member', claimedAt: null },
        },
      ],
      invites: [expect.objectContaining({ kind: 'invite', label: 'Brock', delivery: null, hint: expect.stringMatching(/^ppa_inv_….{4}$/) })],
      seats: { used: 3, max: 10 },
      genie: { available: false },
    });
  });

  it('revokes an open invite, changes nothing on a second revoke, and refuses a used or unknown one', async () => {
    const { invite } = await json<{ invite: { id: number } }>(await mint());
    expect((await owner.request(`/api/professors/invites/${invite.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await owner.request(`/api/professors/invites/${invite.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await json<{ invites: unknown[] }>(await owner.request('/api/professors'))).invites).toEqual([]);

    await member('misty', '0000333');
    const used = (db.prepare('select id from app_invite where accepted_at is not null').get() as { id: number }).id;
    const res = await owner.request(`/api/professors/invites/${used}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('invite_used');
    const unknown = await owner.request('/api/professors/invites/999', { method: 'DELETE' });
    expect(unknown.status).toBe(404);
    expect(await codeOf(unknown)).toBe('invite_not_found');
  });

  it("removes a professor: their connection goes, their login is revoked at Pokémon, and their session and password stop working", async () => {
    const { browser, userId } = await member('misty', '0000333');
    const revokes = () => fake.requests.filter((r) => r.path === '/oauth2/revoke').length;
    const before = revokes();

    expect((await owner.request(`/api/professors/${userId}`, { method: 'DELETE' })).status).toBe(204);

    expect(revokes()).toBe(before + 1);
    expect(db.prepare("select count(*) as n from pokemon_connection where professor_player_id = '0000333'").get()).toEqual({ n: 0 });
    const next = await browser.request('/api/settings');
    expect(next.status).toBe(401);
    expect(next.headers.getSetCookie().join(';')).toMatch(/nuxt-session=;/);
    expect((await client(server.url).request('/api/auth/login', { method: 'POST', json: { username: 'misty', password: 'water types' } })).status).toBe(401);
    expect((await json<{ professors: unknown[]; seats: { used: number } }>(await owner.request('/api/professors'))).professors).toEqual([]);
    expect(server.logs()).toMatch(/professor removed/);

    expect((await owner.request(`/api/professors/${userId}`, { method: 'DELETE' })).status).toBe(204);
  });

  it("refuses to remove or reset the owner, or a user who doesn't exist", async () => {
    const ownerId = (db.prepare("select id from app_user where role = 'owner'").get() as { id: number }).id;
    for (const res of [
      await owner.request(`/api/professors/${ownerId}`, { method: 'DELETE' }),
      await owner.request('/api/professors/999', { method: 'DELETE' }),
      await owner.request(`/api/professors/${ownerId}/reset-link`, { method: 'POST', json: { send: 'copy' } }),
    ]) {
      expect(res.status).toBe(404);
      expect(await codeOf(res)).toBe('professor_not_found');
    }
  });

  it('refuses an eleventh seat', async () => {
    for (let i = 0; i < 9; i++) expect((await mint()).status).toBe(201);
    const res = await mint();
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('invite_limit');
  });

  it.each([
    ['no send', {}],
    ['an unknown send', { send: 'fax' }],
    ['a 61-character label', { send: 'copy', label: 'x'.repeat(61) }],
    ['a blank label', { send: 'copy', label: '   ' }],
    ['a player ID with letters', { send: 'copy', playerId: 'abc' }],
    ['a 21-digit player ID', { send: 'copy', playerId: '1'.repeat(21) }],
    ['Discord with no player ID', { send: 'discord' }],
  ])('rejects an invite with %s as 400', async (_what, body) => {
    expect((await mint(body)).status).toBe(400);
  });

  it('accepts a 60-character label, and keeps markup in it as text', async () => {
    expect((await mint({ send: 'copy', label: 'x'.repeat(60) })).status).toBe(201);
    const res = await mint({ send: 'copy', label: "<img src=x onerror=alert(1)>'; drop table" });
    expect(res.status).toBe(201);
    expect((await json<{ invite: { label: string } }>(res)).invite.label).toBe("<img src=x onerror=alert(1)>'; drop table");
  });

  it.each(['0', 'abc', '1'.repeat(17)])('rejects the professor id %j as 400', async (id) => {
    expect((await owner.request(`/api/professors/${id}`, { method: 'DELETE' })).status).toBe(400);
    expect((await owner.request(`/api/professors/${id}/reset-link`, { method: 'POST', json: { send: 'copy' } })).status).toBe(400);
    expect((await owner.request(`/api/professors/invites/${id}`, { method: 'DELETE' })).status).toBe(400);
  });

  it('rejects a reset link with no send as 400', async () => {
    const { userId } = await member('misty', '0000333');
    expect((await owner.request(`/api/professors/${userId}/reset-link`, { method: 'POST', json: {} })).status).toBe(400);
  });
});
