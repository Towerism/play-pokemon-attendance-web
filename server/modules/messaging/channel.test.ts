import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { messageVault } from '../../bootstrap/vaults';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type DeliveryResult, type MessagingService, createMessagingService } from './channel';
import { MessagingError } from './errors';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const T0 = new Date('2026-10-19T12:00:00Z');
const GENIE = 1;
const SECOND_TOKEN = 2;
const HOUR = 3_600_000;

let database: OpenDatabase;
let messaging: MessagingService;

const rows = () => database.sqlite.prepare('select * from outbound_message order by id').all() as Record<string, unknown>[];
const row = (id: number) => database.sqlite.prepare('select * from outbound_message where id = ?').get(id) as Record<string, unknown>;

function build(key = KEY) {
  return createMessagingService({ db: database.db, vault: messageVault(key), leagueId: L });
}

const invite = (overrides: Partial<Parameters<MessagingService['send']>[0]> = {}) => ({
  playerId: '0012345',
  text: 'organizer invited you to help run Card Shop.',
  link: { label: 'Accept the invite', url: 'https://league.example/invite#ppa_inv_secret' },
  expiresAt: new Date(T0.getTime() + 72 * HOUR),
  topic: 'invite',
  ref: '41',
  ...overrides,
});

/** Genie polls once with no wait, so the channel counts as available. */
async function genieConnects(service = messaging) {
  await service.poll(L, GENIE, { waitMs: 0, limit: 20 });
}

/** Queues a message without waiting for its result. */
async function queued(overrides: Parameters<typeof invite>[0] = {}) {
  const { messageId } = await messaging.send(invite(overrides), { waitMs: 0, sender: 'organizer' });
  return messageId;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  messaging = build();
});
afterEach(() => {
  messaging.drain();
  database.close();
  vi.useRealTimers();
});

describe('available', () => {
  it('is false until Genie polls, and for 2 minutes after its last poll', async () => {
    expect(messaging.available()).toBe(false);
    await genieConnects();
    expect(messaging.available()).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(messaging.available()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(messaging.available()).toBe(false);
  });
});

describe('send', () => {
  it('fails at once with genie_unavailable while Genie is not polling, and queues nothing', async () => {
    const refused = messaging.send(invite(), { waitMs: 1000, sender: 'organizer' });
    await expect(refused).rejects.toBeInstanceOf(MessagingError);
    await expect(refused).rejects.toMatchObject({ code: 'genie_unavailable' });
    expect(rows()).toEqual([]);
  });

  it('queues the message as pending with its link sealed, never in plain text', async () => {
    await genieConnects();
    const id = await queued();

    expect(row(id)).toMatchObject({
      league_id: L,
      player_id: '0012345',
      text: 'organizer invited you to help run Card Shop.',
      topic: 'invite',
      ref: '41',
      link_label: 'Accept the invite',
      status: 'pending',
      attempts: 0,
      created_by: 'organizer',
      next_attempt_at: T0.getTime() / 1000,
      expires_at: T0.getTime() / 1000 + 72 * 3600,
    });
    expect(Buffer.from(row(id).link_ciphertext as Buffer).toString('latin1')).not.toContain('ppa_inv_secret');
    expect(messageVault(KEY).decrypt(row(id).link_ciphertext as Buffer, `outbound_message:${id}`)).toBe('https://league.example/invite#ppa_inv_secret');
  });

  it('resolves with the result Genie reports within the wait', async () => {
    await genieConnects();
    const sending = messaging.send(invite(), { waitMs: 1000, sender: 'organizer' });
    const [message] = await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 });
    vi.advanceTimersByTime(400);
    messaging.report(L, message!.id, { status: 'dm_refused' });

    await expect(sending).resolves.toEqual({ messageId: message!.id, result: { status: 'dm_refused' } });
  });

  it("resolves 'pending' when the wait passes with no result", async () => {
    await genieConnects();
    const sending = messaging.send(invite(), { waitMs: 1000, sender: 'organizer' });
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void sending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(sending).resolves.toMatchObject({ result: 'pending' });
  });

  it('refuses a text over 1,800 characters or a link label over 60 as a programming error', async () => {
    await genieConnects();
    await expect(queued({ text: 'x'.repeat(1801) })).rejects.toThrow(/1,800/);
    await expect(queued({ link: { label: 'x'.repeat(61), url: 'https://x' } })).rejects.toThrow(/60/);
    await expect(queued({ text: 'x'.repeat(1800), link: { label: 'x'.repeat(60), url: 'https://x' } })).resolves.toEqual(expect.any(Number));
  });

  it('queues a message with no link', async () => {
    await genieConnects();
    const id = await queued({ link: undefined });
    expect(row(id)).toMatchObject({ link_label: null, link_ciphertext: null });
  });
});

describe('cancel', () => {
  it('stops a pending message from being handed out, deletes its link and runs no handler', async () => {
    const handler = vi.fn();
    messaging.onResult('invite', handler);
    await genieConnects();
    const id = await queued();

    messaging.cancel(id);

    expect(row(id)).toMatchObject({ status: 'cancelled', link_ciphertext: null });
    expect(await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 })).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves a final message as it is', async () => {
    await genieConnects();
    const id = await queued();
    messaging.report(L, id, { status: 'delivered' });

    messaging.cancel(id);

    expect(row(id)).toMatchObject({ status: 'delivered' });
  });
});

describe('poll', () => {
  it('hands out due messages oldest first, up to the limit, without topic, ref or sender', async () => {
    await genieConnects();
    const ids = [];
    for (let i = 0; i < 25; i++) ids.push(await queued({ playerId: `00${i}` }));

    const handed = await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 });

    expect(handed.map((m) => m.id)).toEqual(ids.slice(0, 20));
    expect(handed[0]).toEqual({
      id: ids[0],
      playerId: '000',
      text: 'organizer invited you to help run Card Shop.',
      link: { label: 'Accept the invite', url: 'https://league.example/invite#ppa_inv_secret' },
      expiresAt: new Date(T0.getTime() + 72 * HOUR).toISOString(),
    });
  });

  it('hides a message it handed out for 60 seconds, then hands it out again with the same link', async () => {
    await genieConnects();
    const id = await queued();
    expect((await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 })).map((m) => m.id)).toEqual([id]);
    expect(await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 })).toEqual([]);

    vi.advanceTimersByTime(60_000);
    const again = await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 });
    expect(again.map((m) => [m.id, m.link?.url])).toEqual([[id, 'https://league.example/invite#ppa_inv_secret']]);
  });

  it('waits for a message and answers as soon as one is queued', async () => {
    await genieConnects();
    const waiting = messaging.poll(L, GENIE, { waitMs: 25_000, limit: 20 });
    await vi.advanceTimersByTimeAsync(5_000);
    const id = await queued();

    expect((await waiting).map((m) => m.id)).toEqual([id]);
  });

  it('answers empty when the wait passes with nothing queued', async () => {
    const waiting = messaging.poll(L, GENIE, { waitMs: 25_000, limit: 20 });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await waiting).toEqual([]);
  });

  it('answers a second poll from the same token at once while the first waits', async () => {
    const first = messaging.poll(L, GENIE, { waitMs: 25_000, limit: 20 });
    expect(await messaging.poll(L, GENIE, { waitMs: 25_000, limit: 20 })).toEqual([]);
    const id = await queued();
    expect((await first).map((m) => m.id)).toEqual([id]);
  });

  it("frees the token's slot when the waiting client goes away, so its next poll waits", async () => {
    const gone = new AbortController();
    const first = messaging.poll(L, GENIE, { waitMs: 25_000, limit: 20, signal: gone.signal });
    gone.abort();
    expect(await first).toEqual([]);

    const next = messaging.poll(L, GENIE, { waitMs: 25_000, limit: 20 });
    const id = await queued();
    expect((await next).map((m) => m.id)).toEqual([id]);
  });

  it("keeps a woken poll waiting when another token's poll took the message", async () => {
    const first = messaging.poll(L, GENIE, { waitMs: 25_000, limit: 20 });
    const second = messaging.poll(L, SECOND_TOKEN, { waitMs: 25_000, limit: 20 });
    const id = await queued();

    const settled = await Promise.race([first, second]);
    expect(settled.map((m) => m.id)).toEqual([id]);
    await vi.advanceTimersByTimeAsync(24_999);
    const other = await Promise.race([first.then((m) => (m === settled ? null : m)), second.then((m) => (m === settled ? null : m)), Promise.resolve('waiting' as const)]);
    expect(other).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect([await first, await second].filter((m) => m !== settled)).toEqual([[]]);
  });

  it('serves only its own league', async () => {
    database.sqlite.prepare(`insert into league (id, name) values ('other', 'Elsewhere')`).run();
    await genieConnects();
    await queued();
    expect(await messaging.poll('other', GENIE, { waitMs: 0, limit: 20 })).toEqual([]);
  });

  it('marks a message whose link no longer decrypts undeliverable instead of handing it out', async () => {
    const handler = vi.fn();
    await genieConnects();
    const id = await queued();
    messaging.drain();
    messaging = build(OTHER_KEY);
    messaging.onResult('invite', handler);

    expect(await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 })).toEqual([]);
    expect(row(id)).toMatchObject({ status: 'undeliverable', status_reason: 'link_unreadable', link_ciphertext: null });
    expect(handler).toHaveBeenCalledWith('41', { status: 'undeliverable', reason: 'link_unreadable' });
  });

  it('expires a pending message past its expiry before handing anything out', async () => {
    const handler = vi.fn();
    messaging.onResult('invite', handler);
    await genieConnects();
    const id = await queued({ expiresAt: new Date(T0.getTime() + 1000) });
    vi.advanceTimersByTime(1000);

    expect(await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 })).toEqual([]);
    expect(row(id)).toMatchObject({ status: 'expired', link_ciphertext: null });
    expect(handler).toHaveBeenCalledWith('41', { status: 'expired' });
  });
});

describe('report', () => {
  it('records a final result, deletes the link and runs the topic handler in the same transaction', async () => {
    const seen: unknown[] = [];
    messaging.onResult('invite', (ref, result) => seen.push([ref, result, row(Number(ref === '41' ? id : 0)).status]));
    await genieConnects();
    const id = await queued();

    messaging.report(L, id, { status: 'delivered' });

    expect(seen).toEqual([['41', { status: 'delivered' }, 'delivered']]);
    expect(row(id)).toMatchObject({ status: 'delivered', link_ciphertext: null, delivered_at: T0.getTime() / 1000, handled_at: T0.getTime() / 1000 });
  });

  it('rolls the result back when the handler throws, so Genie can report it again', async () => {
    messaging.onResult('invite', () => {
      throw new Error('handler failed');
    });
    await genieConnects();
    const id = await queued();

    expect(() => messaging.report(L, id, { status: 'no_discord_user' })).toThrow('handler failed');
    expect(row(id)).toMatchObject({ status: 'pending', handled_at: null });
    expect(row(id).link_ciphertext).not.toBeNull();
  });

  it('backs off after each failure, 1, 2, 4 then 8 minutes, and gives up at the 5th', async () => {
    const handler = vi.fn();
    messaging.onResult('invite', handler);
    await genieConnects();
    const id = await queued();
    const at = (minutes: number) => (T0.getTime() + minutes * 60_000) / 1000;

    for (const minutes of [1, 2, 4, 8]) {
      messaging.report(L, id, { status: 'failed', reason: 'Discord is down' });
      expect(row(id)).toMatchObject({ status: 'pending', next_attempt_at: at(minutes), status_reason: 'Discord is down' });
    }
    expect(handler).not.toHaveBeenCalled();

    messaging.report(L, id, { status: 'failed', reason: 'still down' });
    expect(row(id)).toMatchObject({ status: 'undeliverable', attempts: 5, link_ciphertext: null });
    expect(handler).toHaveBeenCalledWith('41', { status: 'undeliverable', reason: 'still down' });

    messaging.report(L, id, { status: 'delivered' });
    expect(row(id)).toMatchObject({ status: 'undeliverable' });
  });

  it("refuses a message of another league or one that doesn't exist", async () => {
    database.sqlite.prepare(`insert into league (id, name) values ('other', 'Elsewhere')`).run();
    await genieConnects();
    const id = await queued();
    expect(() => messaging.report('other', id, { status: 'delivered' })).toThrow(expect.objectContaining({ code: 'message_not_found' }));
    expect(() => messaging.report(L, 999, { status: 'delivered' })).toThrow(expect.objectContaining({ code: 'message_not_found' }));
  });

  it('changes nothing for a cancelled message', async () => {
    await genieConnects();
    const id = await queued();
    messaging.cancel(id);
    messaging.report(L, id, { status: 'delivered' });
    expect(row(id)).toMatchObject({ status: 'cancelled' });
  });

  it('sets handled_at and nothing else when no handler is registered for the topic', async () => {
    await genieConnects();
    const id = await queued({ topic: 'lease' });
    messaging.report(L, id, { status: 'delivered' });
    expect(row(id)).toMatchObject({ status: 'delivered', handled_at: T0.getTime() / 1000 });
  });
});

describe('replayUnhandled', () => {
  it("hands every final message whose handler hasn't run to its topic's handler", async () => {
    await genieConnects();
    const id = await queued();
    const pending = await queued({ ref: '42' });
    database.sqlite.prepare(`update outbound_message set status = 'dm_refused', link_ciphertext = null where id = ?`).run(id);
    const handler = vi.fn();
    messaging.onResult('invite', handler);

    expect(messaging.replayUnhandled()).toBe(1);

    expect(handler).toHaveBeenCalledExactlyOnceWith('41', { status: 'dm_refused' });
    expect(row(id).handled_at).toBe(T0.getTime() / 1000);
    expect(row(pending).handled_at).toBeNull();
    expect(messaging.replayUnhandled()).toBe(0);
  });
});

describe('expire', () => {
  it('expires pending messages past their expiry and deletes messages older than 30 days', async () => {
    const handler = vi.fn();
    messaging.onResult('invite', handler);
    await genieConnects();
    const late = await queued({ expiresAt: new Date(T0.getTime() + HOUR) });
    const old = await queued({ ref: '1' });
    const recent = await queued({ ref: '2', expiresAt: new Date(T0.getTime() + 60 * 24 * HOUR) });
    const day = 24 * HOUR;
    database.sqlite.prepare('update outbound_message set created_at = ? where id = ?').run((T0.getTime() - 31 * day) / 1000, old);
    database.sqlite.prepare('update outbound_message set created_at = ? where id = ?').run((T0.getTime() - 29 * day) / 1000, recent);
    vi.advanceTimersByTime(HOUR);

    expect(messaging.expire()).toEqual({ expired: 1, deleted: 1 });

    expect(row(late)).toMatchObject({ status: 'expired', link_ciphertext: null });
    expect(handler).toHaveBeenCalledWith('41', { status: 'expired' });
    expect(row(old)).toBeUndefined();
    expect(row(recent)).toMatchObject({ status: 'pending' });
  });
});

describe('drain', () => {
  it("answers waiting polls empty, resolves waiting sends 'pending', and refuses new polls", async () => {
    await genieConnects();
    const sending = messaging.send(invite(), { waitMs: 10_000, sender: 'organizer' });
    await messaging.poll(L, GENIE, { waitMs: 0, limit: 20 });
    const waiting = messaging.poll(L, GENIE, { waitMs: 25_000, limit: 20 });

    messaging.drain();
    messaging.drain();

    await expect(waiting).resolves.toEqual([]);
    await expect(sending).resolves.toMatchObject({ result: 'pending' });
    await expect(messaging.poll(L, GENIE, { waitMs: 0, limit: 20 })).rejects.toMatchObject({ code: 'shutting_down' });
    expect(rows()).toHaveLength(1);
  });
});

export type { DeliveryResult };
