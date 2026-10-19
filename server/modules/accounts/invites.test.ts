import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { messageVault } from '../../bootstrap/vaults';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type MessagingService, createMessagingService } from '../messaging/channel';
import { MessagingError } from '../messaging/errors';
import { type InviteService, createInviteService } from './invites';
import type { Actor, PasswordHasher } from './service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const T0 = new Date('2026-10-19T12:00:00Z');
const HOUR = 3_600_000;
const SITE = 'https://league.example';
const GENIE = 1;
const SECRET = /^ppa_inv_[A-Za-z0-9_-]{43}$/;

let database: OpenDatabase;
let messaging: MessagingService;
let invites: InviteService;
let ownerConnections: number;
let recipients: Map<number, string>;
let owner: Actor;

const hasher: PasswordHasher = {
  hash: async (pw) => `hashed:${pw}`,
  verify: async (hash, pw) => hash === `hashed:${pw}`,
};
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const inviteRow = (id: number) => database.sqlite.prepare('select * from app_invite where id = ?').get(id) as Record<string, unknown>;
const messageRow = (id: number) => database.sqlite.prepare('select * from outbound_message where id = ?').get(id) as Record<string, unknown>;
const user = (username: string) => database.sqlite.prepare('select * from app_user where username = ?').get(username) as Record<string, unknown> | undefined;

function build(opts: { siteUrl?: string | null; channel?: MessagingService } = {}) {
  return createInviteService({
    db: database.db,
    hasher,
    channel: opts.channel ?? messaging,
    connections: { ownerConnectionCount: () => ownerConnections, recipientOf: (userId) => recipients.get(userId) ?? null },
    leagueId: L,
    leagueName: () => 'Card Shop',
    timeZone: 'America/Chicago',
    siteUrl: opts.siteUrl === undefined ? SITE : opts.siteUrl,
    sendWaitMs: 10_000,
  });
}

function addUser(username: string, opts: { role?: 'owner' | 'professor'; removed?: boolean } = {}): number {
  return (
    database.sqlite
      .prepare(`insert into app_user (username, password_hash, role, removed_at, created_at) values (?, 'hashed:old password', ?, ?, 1) returning id`)
      .get(username, opts.role ?? 'professor', opts.removed ? 1 : null) as { id: number }
  ).id;
}

/** An invite row in a given state, minted by the owner directly, for counting and refusal tests. */
function inviteIn(state: 'open' | 'used' | 'revoked' | 'expired' | 'reset', secret = `ppa_inv_${state}${Math.random()}`): string {
  const t = T0.getTime() / 1000;
  const forUser = state === 'reset' ? addUser(`reset-${Math.random().toString(36).slice(2, 8)}`) : null;
  database.sqlite
    .prepare(
      `insert into app_invite (league_id, secret_hash, secret_hint, created_by, created_at, expires_at, revoked_at, accepted_at, for_user_id)
       values ('default', ?, 'ppa_inv_…x', 'organizer', ?, ?, ?, ?, ?)`,
    )
    .run(sha256(secret), t, state === 'expired' ? t : t + 72 * 3600, state === 'revoked' ? t : null, state === 'used' ? t : null, forUser);
  return secret;
}

async function genieConnects() {
  await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 });
}

/** Genie takes the one message waiting and reports `status` on it, after `afterMs`. */
async function genieReports(status: 'delivered' | 'no_discord_user' | 'dm_refused', afterMs = 0) {
  await vi.advanceTimersByTimeAsync(afterMs);
  const [message] = await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 });
  messaging.report(L, message!.id, { status });
  return message!;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  messaging = createMessagingService({ db: database.db, vault: messageVault(Buffer.alloc(32, 3).toString('base64')), leagueId: L });
  ownerConnections = 1;
  recipients = new Map();
  owner = { userId: addUser('organizer', { role: 'owner' }), username: 'organizer', role: 'owner' };
  invites = build();
});
afterEach(() => {
  messaging.drain();
  database.close();
  vi.useRealTimers();
});

describe('minting an invite to copy', () => {
  it('returns the secret and link once, and stores only the SHA-256, a hint and a 72-hour expiry', async () => {
    const minted = await invites.mint(owner, { label: 'Misty', send: 'copy' });

    expect(minted.secret).toMatch(SECRET);
    expect(minted.link).toBe(`${SITE}/invite#${minted.secret}`);
    const row = inviteRow(minted.invite.id);
    expect(row).toMatchObject({
      secret_hash: sha256(minted.secret!),
      secret_hint: `ppa_inv_…${minted.secret!.slice(-4)}`,
      label: 'Misty',
      created_by: 'organizer',
      created_at: T0.getTime() / 1000,
      expires_at: T0.getTime() / 1000 + 72 * 3600,
      delivery: null,
    });
    expect(JSON.stringify(row)).not.toContain(minted.secret);
    expect(minted.invite).toEqual({
      id: minted.invite.id,
      kind: 'invite',
      label: 'Misty',
      playerId: null,
      username: null,
      hint: `ppa_inv_…${minted.secret!.slice(-4)}`,
      createdBy: 'organizer',
      createdAt: T0.toISOString(),
      expiresAt: new Date(T0.getTime() + 72 * HOUR).toISOString(),
      delivery: null,
    });
    expect(invites.openInvites()).toEqual([minted.invite]);
  });

  it('gives no link without a site URL, so the browser builds one from its own address', async () => {
    const minted = await build({ siteUrl: null }).mint(owner, { send: 'copy' });
    expect(minted.secret).toMatch(SECRET);
    expect(minted.link).toBeNull();
  });

  it('builds the link from a site URL with a trailing slash', async () => {
    const minted = await build({ siteUrl: `${SITE}/` }).mint(owner, { send: 'copy' });
    expect(minted.link).toBe(`${SITE}/invite#${minted.secret}`);
  });

  it('binds the invite to a player ID when given one', async () => {
    const minted = await invites.mint(owner, { playerId: '0012345', send: 'copy' });
    expect(inviteRow(minted.invite.id)).toMatchObject({ for_player_id: '0012345' });
    expect(minted.invite.playerId).toBe('0012345');
  });
});

describe('seats', () => {
  it("count the owner's connections, active professors and open invites, and nothing else", () => {
    ownerConnections = 2;
    addUser('misty');
    addUser('brock');
    addUser('gary', { removed: true });
    inviteIn('open');
    inviteIn('used');
    inviteIn('revoked');
    inviteIn('expired');
    inviteIn('reset'); // adds a professor too: the reset's own user

    expect(invites.seatsUsed()).toBe(2 + 3 + 1);
  });

  it('refuse a mint once 10 are used, inserting nothing', async () => {
    ownerConnections = 2;
    for (const name of ['a1', 'a2', 'a3']) addUser(name);
    for (let i = 0; i < 4; i++) inviteIn('open');

    await invites.mint(owner, { send: 'copy' });
    expect(invites.seatsUsed()).toBe(10);
    const before = database.sqlite.prepare('select count(*) as n from app_invite').get();
    await expect(invites.mint(owner, { send: 'copy' })).rejects.toMatchObject({ code: 'invite_limit' });
    expect(database.sqlite.prepare('select count(*) as n from app_invite').get()).toEqual(before);
  });
});

describe('revoking', () => {
  it('revokes an open invite and cancels its pending message', async () => {
    await genieConnects();
    const sending = invites.mint(owner, { playerId: '0012345', send: 'discord' });
    await vi.advanceTimersByTimeAsync(10_000);
    const { invite } = await sending;

    invites.revoke(invite.id);

    expect(inviteRow(invite.id)).toMatchObject({ revoked_at: T0.getTime() / 1000 + 10 });
    expect(messageRow(inviteRow(invite.id).message_id as number)).toMatchObject({ status: 'cancelled', link_ciphertext: null });
    expect(await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 })).toEqual([]);
    expect(invites.openInvites()).toEqual([]);
  });

  it('changes nothing for one already revoked or expired, refuses a used one, and names an unknown one', async () => {
    const { invite } = await invites.mint(owner, { send: 'copy' });
    invites.revoke(invite.id);
    vi.advanceTimersByTime(1000);
    invites.revoke(invite.id);
    expect(inviteRow(invite.id)).toMatchObject({ revoked_at: T0.getTime() / 1000 });

    const used = await invites.mint(owner, { send: 'copy' });
    await invites.accept({ secret: used.secret!, username: 'misty', password: 'new password' });
    expect(() => invites.revoke(used.invite.id)).toThrow(expect.objectContaining({ code: 'invite_used' }));
    expect(() => invites.revoke(999)).toThrow(expect.objectContaining({ code: 'invite_not_found' }));
  });
});

describe('sending an invite by Discord', () => {
  it('refuses while Genie is not polling, and writes nothing', async () => {
    await expect(invites.mint(owner, { playerId: '0012345', send: 'discord' })).rejects.toMatchObject({ code: 'genie_unavailable' });
    expect(database.sqlite.prepare('select count(*) as n from app_invite').get()).toEqual({ n: 0 });
  });

  it('refuses without a site URL, and writes nothing', async () => {
    await genieConnects();
    await expect(build({ siteUrl: null }).mint(owner, { playerId: '0012345', send: 'discord' })).rejects.toMatchObject({ code: 'site_url_not_set' });
    expect(database.sqlite.prepare('select count(*) as n from app_invite').get()).toEqual({ n: 0 });
  });

  it('sends the invite text and link to the bound player and answers delivered, with no secret', async () => {
    await genieConnects();
    const sending = invites.mint(owner, { playerId: '0012345', send: 'discord' });
    const message = await genieReports('delivered', 300);
    const minted = await sending;

    expect(message.playerId).toBe('0012345');
    expect(message.text).toMatch(/^organizer invited you to help run Card Shop on Play! Pokémon Attendance\. The link works once, until /);
    expect(message.link).toEqual({ label: 'Accept the invite', url: expect.stringMatching(new RegExp(`^${SITE}/invite#ppa_inv_[A-Za-z0-9_-]{43}$`)) });
    expect(message.expiresAt).toBe(new Date(T0.getTime() + 72 * HOUR).toISOString());
    expect(minted).toEqual({ invite: expect.objectContaining({ delivery: 'delivered', playerId: '0012345' }) });
    expect(minted).not.toHaveProperty('secret');
    expect(inviteRow(minted.invite.id)).toMatchObject({ delivery: 'delivered', revoked_at: null, message_id: message.id });
  });

  it.each(['no_discord_user', 'dm_refused'] as const)('revokes the invite when Genie reports %s within the wait', async (status) => {
    await genieConnects();
    const sending = invites.mint(owner, { playerId: '0012345', send: 'discord' });
    const failure = sending.catch((e: unknown) => e);
    await genieReports(status, 300);

    expect(await failure).toMatchObject({ code: status });
    const row = database.sqlite.prepare('select * from app_invite').get() as Record<string, unknown>;
    expect(row).toMatchObject({ delivery: status, revoked_at: T0.getTime() / 1000 });
    expect(invites.openInvites()).toEqual([]);
  });

  it("answers 'sending' when Genie hasn't reported within the wait, and revokes the invite on a later refusal", async () => {
    await genieConnects();
    const sending = invites.mint(owner, { playerId: '0012345', send: 'discord' });
    await vi.advanceTimersByTimeAsync(10_000);
    const { invite } = await sending;
    expect(invite.delivery).toBe('sending');

    await genieReports('dm_refused');

    expect(inviteRow(invite.id)).toMatchObject({ delivery: 'dm_refused', revoked_at: expect.any(Number) });
    expect(invites.openInvites()).toEqual([]);
  });

  it('records a late delivery without revoking', async () => {
    await genieConnects();
    const sending = invites.mint(owner, { playerId: '0012345', send: 'discord' });
    await vi.advanceTimersByTimeAsync(10_000);
    const { invite } = await sending;
    await genieReports('delivered');
    expect(inviteRow(invite.id)).toMatchObject({ delivery: 'delivered', revoked_at: null });
  });

  it('deletes the invite when Genie goes quiet between the check and the send', async () => {
    await genieConnects();
    const quiet: MessagingService = { ...messaging, send: () => Promise.reject(new MessagingError('genie_unavailable', 'gone')) };
    await expect(build({ channel: quiet }).mint(owner, { playerId: '0012345', send: 'discord' })).rejects.toBeInstanceOf(MessagingError);
    expect(database.sqlite.prepare('select count(*) as n from app_invite').get()).toEqual({ n: 0 });
  });

  it('cancels the message when the invite is revoked while the send is still waiting', async () => {
    await genieConnects();
    const sending = invites.mint(owner, { playerId: '0012345', send: 'discord' });
    await vi.advanceTimersByTimeAsync(1);
    const id = (database.sqlite.prepare('select id from app_invite').get() as { id: number }).id;
    invites.revoke(id);
    await vi.advanceTimersByTimeAsync(10_000);
    await sending;

    expect(messageRow(inviteRow(id).message_id as number)).toMatchObject({ status: 'cancelled' });
  });
});

describe('checking a link', () => {
  it('describes an open invite', async () => {
    const { secret } = await invites.mint(owner, { label: 'Misty', send: 'copy' });
    expect(invites.check(secret!)).toEqual({ kind: 'invite', label: 'Misty', leagueName: 'Card Shop', expiresAt: new Date(T0.getTime() + 72 * HOUR).toISOString(), username: null });
  });

  it('names the professor of a reset link', async () => {
    const misty = addUser('misty');
    const { secret } = await invites.mintReset(owner, misty, 'copy');
    expect(invites.check(secret!)).toMatchObject({ kind: 'reset', username: 'misty', label: null });
  });

  it.each(['unknown', 'malformed', 'expired', 'used', 'revoked'] as const)('refuses a %s link alike', async (state) => {
    const secret = state === 'unknown' ? `ppa_inv_${'A'.repeat(43)}` : state === 'malformed' ? 'abc' : inviteIn(state);
    let caught: unknown;
    try {
      invites.check(secret);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'invite_invalid', message: "This link doesn't work. It may have expired, been used or been revoked." });
  });

  it('refuses a reset link whose professor has since been removed', async () => {
    const misty = addUser('misty');
    const { secret } = await invites.mintReset(owner, misty, 'copy');
    database.sqlite.prepare('update app_user set removed_at = 1 where id = ?').run(misty);
    expect(() => invites.check(secret!)).toThrow(expect.objectContaining({ code: 'invite_invalid' }));
  });
});

describe('accepting an invite', () => {
  it('creates a signed-in professor and marks the invite used', async () => {
    const { invite, secret } = await invites.mint(owner, { send: 'copy' });

    const created = await invites.accept({ secret: secret!, username: 'misty', password: 'water types' });

    expect(created).toEqual({ id: expect.any(Number), username: 'misty' });
    expect(user('misty')).toMatchObject({ role: 'professor', password_hash: 'hashed:water types', last_sign_in_at: T0.getTime() / 1000, removed_at: null, reverify_required_at: null });
    expect(inviteRow(invite.id)).toMatchObject({ accepted_at: T0.getTime() / 1000, accepted_user_id: created.id });
    expect(() => invites.check(secret!)).toThrow(expect.objectContaining({ code: 'invite_invalid' }));
  });

  it('cancels a pending Discord message when the invite is accepted before Genie reports', async () => {
    await genieConnects();
    const sending = invites.mint(owner, { playerId: '0012345', send: 'discord' });
    await vi.advanceTimersByTimeAsync(10_000);
    await sending;
    const message = await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 });
    const secret = message[0]!.link!.url.split('#')[1]!;

    await invites.accept({ secret, username: 'misty', password: 'water types' });

    expect(messageRow(message[0]!.id)).toMatchObject({ status: 'cancelled' });
  });

  it.each([['active', false], ['removed', true]] as const)('refuses a username taken by an %s user and leaves the invite open', async (_state, removed) => {
    addUser('misty', { removed });
    const { secret } = await invites.mint(owner, { send: 'copy' });
    await expect(invites.accept({ secret: secret!, username: 'misty', password: 'water types' })).rejects.toMatchObject({ code: 'username_taken' });
    expect(invites.check(secret!)).toMatchObject({ kind: 'invite' });
  });

  it('needs a username for an invite', async () => {
    const { secret } = await invites.mint(owner, { send: 'copy' });
    await expect(invites.accept({ secret: secret!, password: 'water types' })).rejects.toMatchObject({ code: 'username_required' });
  });

  it('refuses an invalid link before anything else', async () => {
    await expect(invites.accept({ secret: inviteIn('used'), username: 'misty', password: 'water types' })).rejects.toMatchObject({ code: 'invite_invalid' });
    expect(user('misty')).toBeUndefined();
  });

  it('lets exactly one of two accepts of the same invite win', async () => {
    const { secret } = await invites.mint(owner, { send: 'copy' });
    const results = await Promise.allSettled([
      invites.accept({ secret: secret!, username: 'misty', password: 'water types' }),
      invites.accept({ secret: secret!, username: 'brock', password: 'rock types' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'invite_invalid' } });
  });
});

describe('reset links', () => {
  it('set a new password, keep the username, and hold the professor until they prove their Pokémon login', async () => {
    const misty = addUser('misty');
    const { invite, secret } = await invites.mintReset(owner, misty, 'copy');

    const reset = await invites.accept({ secret: secret!, username: 'ignored', password: 'new password' });

    expect(reset).toEqual({ id: misty, username: 'misty' });
    expect(user('misty')).toMatchObject({ password_hash: 'hashed:new password', reverify_required_at: T0.getTime() / 1000 });
    expect(user('ignored')).toBeUndefined();
    expect(inviteRow(invite.id)).toMatchObject({ accepted_user_id: misty, for_user_id: misty });
  });

  it('revoke an earlier open reset link for the same professor, and take no seat', async () => {
    const misty = addUser('misty');
    const first = await invites.mintReset(owner, misty, 'copy');
    const seats = invites.seatsUsed();
    const second = await invites.mintReset(owner, misty, 'copy');

    expect(inviteRow(first.invite.id).revoked_at).not.toBeNull();
    expect(inviteRow(second.invite.id).revoked_at).toBeNull();
    expect(invites.seatsUsed()).toBe(seats);
    expect(second.invite).toMatchObject({ kind: 'reset', username: 'misty' });
  });

  it("go by Discord to the professor's own connection", async () => {
    const misty = addUser('misty');
    recipients.set(misty, '0012345');
    await genieConnects();
    const sending = invites.mintReset(owner, misty, 'discord');
    const message = await genieReports('delivered', 100);
    await sending;

    expect(message.playerId).toBe('0012345');
    expect(message.text).toMatch(/^organizer sent you a link to set a new password for misty on Play! Pokémon Attendance\./);
    expect(message.link?.label).toBe('Set a new password');
  });

  it('refuse Discord for a professor with no connection, before writing anything', async () => {
    const misty = addUser('misty');
    await genieConnects();
    await expect(invites.mintReset(owner, misty, 'discord')).rejects.toMatchObject({ code: 'no_recipient' });
    expect(database.sqlite.prepare('select count(*) as n from app_invite').get()).toEqual({ n: 0 });
  });

  it.each([
    ['the owner', () => owner.userId],
    ['an unknown user', () => 999],
    ['a removed professor', () => addUser('gone', { removed: true })],
  ])('refuse %s', async (_who, id) => {
    await expect(invites.mintReset(owner, id(), 'copy')).rejects.toMatchObject({ code: 'professor_not_found' });
  });

  it('are revoked with their messages when the professor is removed', async () => {
    const misty = addUser('misty');
    const { invite } = await invites.mintReset(owner, misty, 'copy');
    invites.revokeResetLinksOf(misty);
    expect(inviteRow(invite.id).revoked_at).not.toBeNull();
  });
});

describe('the player ID an invite binds', () => {
  it('is the bound ID of the invite the professor accepted, and null otherwise', async () => {
    const { secret } = await invites.mint(owner, { playerId: '0012345', send: 'copy' });
    const misty = await invites.accept({ secret: secret!, username: 'misty', password: 'water types' });
    const free = await invites.mint(owner, { send: 'copy' });
    const brock = await invites.accept({ secret: free.secret!, username: 'brock', password: 'rock types' });

    expect(invites.boundPlayerId(misty.id)).toBe('0012345');
    expect(invites.boundPlayerId(brock.id)).toBeNull();
    expect(invites.boundPlayerId(owner.userId)).toBeNull();
  });
});
