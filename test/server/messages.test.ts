import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MessagesV1 } from '../../shared/schemas/integrations';
import { type FakePokemon, startFakePokemon } from './fake-pokemon';
import { type Genie, connectGenie, genieWith, mintToken } from './genie';
import { type TestServer, client, startServer } from './harness';

// The Discord channel Genie long-polls (ADR-0015 §7), and Send by Discord on top of it (§6), against the built server.
// The test plays Genie with a real bearer token, so the poll and the owner's request run at the same time, as they do.

const OWNER = { username: 'organizer', password: 'correct horse' };
const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };
const SITE = 'https://league.example';
const INSUFFICIENT = 'Bearer realm="integrations", error="insufficient_scope"';

type Browser = ReturnType<typeof client>;

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const codeOf = async (res: Response) => (await json<{ data?: { code?: string } }>(res)).data?.code;

let server: TestServer;
let owner: Browser;
let db: Database.Database;

async function start(env: Record<string, string> = {}, dataDir?: string) {
  server = await startServer({ env: { ...fake.env, TZ: 'America/Chicago', NUXT_PUBLIC_SITE_URL: SITE, ...env }, dataDir });
  owner = client(server.url);
  if (!dataDir) {
    expect((await owner.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } })).status).toBe(200);
    // The owner's account picks the league, so the invite text can name it.
    const begun = await owner.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
    const state = new URL((await json<{ authorizeUrl: string }>(begun)).authorizeUrl).searchParams.get('state');
    const done = await owner.request('/api/pokemon/connect/complete', { method: 'POST', json: { url: `https://play-tools.pokemon.com/loggedIn?code=fresh&state=${state}` } });
    expect(done.status).toBe(200);
  } else {
    expect((await owner.request('/api/auth/login', { method: 'POST', json: OWNER })).status).toBe(200);
  }
  db = new Database(join(server.dataDir, 'app.db'));
  db.pragma('busy_timeout = 5000');
}

beforeEach(() => {
  fake.accounts.splice(1);
  fake.leagues = [CARD_SHOP];
});

afterEach(async () => {
  db?.close();
  expect(server.logs()).not.toMatch(/ppa_inv_[A-Za-z0-9_-]{5,}/);
  await server.dispose();
});

const sendInvite = (playerId = '0012345') => owner.request('/api/professors/invites', { method: 'POST', json: { playerId, send: 'discord' } });
const inviteRows = () => db.prepare('select * from app_invite order by id').all() as Record<string, unknown>[];

/** Starts the owner's Send by Discord and takes the message Genie's poll gets for it. */
async function sendAndTake(genie: Genie, playerId = '0012345') {
  const sending = sendInvite(playerId);
  const [message] = await genie.poll({ wait: 25 });
  return { sending, message: message! };
}

describe('Send by Discord', () => {
  it('refuses while Genie is not polling, and writes nothing', async () => {
    await start();
    const res = await sendInvite();
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe('genie_unavailable');
    expect(inviteRows()).toEqual([]);
  });

  it('refuses without a site URL, and writes nothing', async () => {
    await start({ NUXT_PUBLIC_SITE_URL: '' });
    await connectGenie(server.url, owner);
    const res = await sendInvite();
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('site_url_not_set');
    expect(inviteRows()).toEqual([]);
  });

  it("delivers the invite to the bound player through Genie's poll and answers 201, with no secret or link", async () => {
    await start();
    const genie = await connectGenie(server.url, owner);
    const { sending, message } = await sendAndTake(genie);

    expect(MessagesV1.shape.messages.element.parse(message)).toEqual(message);
    expect(message).toMatchObject({ playerId: '0012345', link: { label: 'Accept the invite', url: expect.stringMatching(new RegExp(`^${SITE}/invite#ppa_inv_[A-Za-z0-9_-]{43}$`)) } });
    expect(message.text).toMatch(/^organizer invited you to help run Card Shop on Play! Pokémon Attendance\./);
    expect((await genie.report(message.id, 'delivered')).status).toBe(204);

    const res = await sending;
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toMatch(/ppa_inv_[A-Za-z0-9_-]{5,}|"secret"|"link"/);
    expect(JSON.parse(text)).toEqual({ invite: expect.objectContaining({ delivery: 'delivered', playerId: '0012345' }) });
    expect(server.logs()).toMatch(/invite minted/);
    expect(server.logs()).toMatch(/outbound message handed out/);
  });

  it.each(['no_discord_user', 'dm_refused'])('answers 422 and revokes the invite when Genie reports %s', async (status) => {
    await start();
    const genie = await connectGenie(server.url, owner);
    const { sending, message } = await sendAndTake(genie);
    await genie.report(message.id, status);

    const res = await sending;
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe(status);
    expect(inviteRows()).toEqual([expect.objectContaining({ delivery: status, revoked_at: expect.any(Number) })]);
  });

  it("answers 202 while Genie hasn't reported, and a later refusal still revokes the invite", async () => {
    await start({ NUXT_MESSAGING_SEND_WAIT_MS: '300' });
    const genie = await connectGenie(server.url, owner);
    const res = await sendInvite();
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ invite: expect.objectContaining({ delivery: 'sending' }) });
    expect((await json<{ invites: unknown[] }>(await owner.request('/api/professors'))).invites).toEqual([expect.objectContaining({ delivery: 'sending' })]);

    const [message] = await genie.poll();
    expect((await genie.report(message!.id, 'dm_refused')).status).toBe(204);
    expect((await json<{ invites: unknown[] }>(await owner.request('/api/professors'))).invites).toEqual([]);
  });

  it('sends a reset link to the professor’s own connection, and refuses one who has none', async () => {
    await start({ NUXT_MESSAGING_SEND_WAIT_MS: '300' });
    const genie = await connectGenie(server.url, owner);
    db.prepare("insert into app_user (username, password_hash, role, created_at) values ('misty', 'h', 'professor', 1)").run();
    const misty = (db.prepare("select id from app_user where username = 'misty'").get() as { id: number }).id;

    const none = await owner.request(`/api/professors/${misty}/reset-link`, { method: 'POST', json: { send: 'discord' } });
    expect(none.status).toBe(409);
    expect(await codeOf(none)).toBe('no_recipient');
    expect(inviteRows()).toEqual([]);

    const account = fake.addAccount({ playerId: '0000333', name: 'Misty', leagues: [CARD_SHOP] });
    db.prepare(
      `insert into pokemon_connection (user_id, professor_player_id, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at)
       values (?, '0000333', ?, x'00', 'connected', 1, 1)`,
    ).run(misty, account.sub);
    expect((await owner.request(`/api/professors/${misty}/reset-link`, { method: 'POST', json: { send: 'discord' } })).status).toBe(202);
    const [message] = await genie.poll();
    expect(message).toMatchObject({ playerId: '0000333', link: { label: 'Set a new password' } });
  });
});

describe("Genie's wire", () => {
  it('wakes a waiting poll as soon as a message is queued, then hides that message from the next poll', async () => {
    await start({ NUXT_MESSAGING_SEND_WAIT_MS: '50' });
    const genie = await connectGenie(server.url, owner);
    const waiting = genie.poll({ wait: 25 });
    await new Promise((r) => setTimeout(r, 200));
    const queuedAt = Date.now();
    expect((await sendInvite()).status).toBe(202);

    const messages = await waiting;
    expect(Date.now() - queuedAt).toBeLessThan(1000);
    expect(messages).toHaveLength(1);
    expect(await genie.poll()).toEqual([]);
  });

  it('answers a second poll from the same token at once, and frees the slot when a waiting client goes away', async () => {
    await start();
    const genie = await connectGenie(server.url, owner);
    const gone = new AbortController();
    const first = genie.pollResponse({ wait: 25, signal: gone.signal }).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 200));
    const at = Date.now();
    expect(await genie.poll({ wait: 25 })).toEqual([]);
    expect(Date.now() - at).toBeLessThan(2000);

    gone.abort();
    expect(await first).toBe('aborted');
    await new Promise((r) => setTimeout(r, 200));
    const next = genie.poll({ wait: 2 });
    const started = Date.now();
    expect(await next).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
  });

  it.each([
    ['wait=-1', '?wait=-1'],
    ['wait=26', '?wait=26'],
    ['wait=1.5', '?wait=1.5'],
    ['wait=x', '?wait=x'],
    ['limit=0', '?limit=0'],
    ['limit=51', '?limit=51'],
  ])('rejects %s as 400', async (_what, query) => {
    await start();
    const secret = await mintToken(owner);
    const res = await fetch(`${server.url}/api/integrations/v1/messages${query}`, { headers: { authorization: `Bearer ${secret}` } });
    expect(res.status).toBe(400);
  });

  it('accepts wait 0 and 25, limit 1 and 50', async () => {
    await start();
    const genie = genieWith(server.url, await mintToken(owner));
    expect((await genie.pollResponse({ wait: 0, limit: 1 })).status).toBe(200);
    expect((await genie.pollResponse({ wait: 0, limit: 50 })).status).toBe(200);
  });

  it("refuses a result for a message that doesn't exist, and a malformed result", async () => {
    await start();
    const genie = await connectGenie(server.url, owner);
    const missing = await genie.report(999, 'delivered');
    expect(missing.status).toBe(404);
    expect(await codeOf(missing)).toBe('message_not_found');
    expect((await genie.report(1, 'sent')).status).toBe(400);
    expect((await genie.report(1, 'failed', 'x'.repeat(201))).status).toBe(400);
    expect((await fetch(`${server.url}/api/integrations/v1/messages/abc/result`, { method: 'POST', headers: { authorization: `Bearer ${genie.secret}` } })).status).toBe(400);
  });

  it('takes only a bearer token with messages:deliver: never a session, a missing or revoked token, or another scope', async () => {
    await start();
    const reader = await mintToken(owner, ['integrations:read'], 'Reader');
    const deliverer = await mintToken(owner, ['messages:deliver'], 'Genie');
    const call = (authorization?: string, path = '/api/integrations/v1/messages') => fetch(`${server.url}${path}`, { headers: authorization ? { authorization } : {} });

    expect((await call()).status).toBe(401);
    expect((await owner.request('/api/integrations/v1/messages')).status).toBe(401);
    expect((await call(`Bearer ppa_int_${'A'.repeat(43)}`)).status).toBe(401);

    const wrong = await call(`Bearer ${reader}`);
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get('www-authenticate')).toBe(INSUFFICIENT);
    expect(await codeOf(wrong)).toBe('insufficient_scope');
    const report = await fetch(`${server.url}/api/integrations/v1/messages/1/result`, { method: 'POST', headers: { authorization: `Bearer ${reader}`, 'content-type': 'application/json' }, body: '{"status":"delivered"}' });
    expect(report.status).toBe(403);

    const day = await call(`Bearer ${deliverer}`, '/api/integrations/v1/days/2026-10-14');
    expect(day.status).toBe(403);
    expect(day.headers.get('www-authenticate')).toBe(INSUFFICIENT);
    expect((await call(`Bearer ${deliverer}`)).status).toBe(200);
  });

  it('counts polls and results apart, per token', async () => {
    await start({ NUXT_MESSAGE_POLL_RATE_LIMIT_MAX: '2', NUXT_MESSAGE_RESULT_RATE_LIMIT_MAX: '2' });
    const genie = genieWith(server.url, await mintToken(owner));
    expect((await genie.pollResponse()).status).toBe(200);
    expect((await genie.pollResponse()).status).toBe(200);
    const limited = await genie.pollResponse();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await genie.report(999, 'delivered')).status).toBe(404);
    expect((await genie.report(999, 'delivered')).status).toBe(404);
    expect((await genie.report(999, 'delivered')).status).toBe(429);
  });
});

describe('restarts', () => {
  it('answers a waiting poll empty at once on SIGTERM, and still stops well inside the 8-second limit', async () => {
    await start();
    const genie = await connectGenie(server.url, owner);
    const waiting = genie.pollResponse({ wait: 25 });
    await new Promise((r) => setTimeout(r, 300));

    const signalled = Date.now();
    const stopping = server.stop();
    const res = await waiting;
    expect(Date.now() - signalled).toBeLessThan(1000);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
    await stopping;
    expect(Date.now() - signalled).toBeLessThan(8000);
    await start({}, server.dataDir);
  });

  it("runs an invite's handler at boot for a result recorded before a crash", async () => {
    await start({ NUXT_MESSAGING_SEND_WAIT_MS: '50' });
    await connectGenie(server.url, owner);
    expect((await sendInvite()).status).toBe(202);
    db.prepare("update outbound_message set status = 'no_discord_user', link_ciphertext = null, handled_at = null").run();
    const dataDir = server.dataDir;
    db.close();
    await server.kill();

    await start({}, dataDir);

    expect(inviteRows()).toEqual([expect.objectContaining({ delivery: 'no_discord_user', revoked_at: expect.any(Number) })]);
    expect(db.prepare('select handled_at from outbound_message').get()).toEqual({ handled_at: expect.any(Number) });
  });

  it('never hands out a link sealed under a message vault key the app no longer has, and revokes its invite', async () => {
    await start({ NUXT_MESSAGING_SEND_WAIT_MS: '50', NUXT_MESSAGE_VAULT_KEY: randomBytes(32).toString('base64') });
    await connectGenie(server.url, owner);
    expect((await sendInvite()).status).toBe(202);
    const dataDir = server.dataDir;
    db.close();
    await server.stop();

    await start({ NUXT_MESSAGE_VAULT_KEY: randomBytes(32).toString('base64') }, dataDir);
    const genie = await connectGenie(server.url, owner);

    expect(await genie.poll()).toEqual([]);
    expect(db.prepare('select status, status_reason from outbound_message').get()).toEqual({ status: 'undeliverable', status_reason: 'link_unreadable' });
    expect(inviteRows()).toEqual([expect.objectContaining({ delivery: 'undeliverable', revoked_at: expect.any(Number) })]);
  });
});
