import { type Logger, type StringVault, silentLogger } from '@towerism/selfhost-kit';
import { VaultError } from '@towerism/selfhost-kit';
import { and, asc, eq, isNull, lt, lte, ne } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { outboundMessage } from '../../db/schema';
import { MessagingError } from './errors';

/** What Genie reported for a message, or what became of it (ADR-0015 §7). */
export type DeliveryResult =
  | { status: 'delivered' }
  /** Genie has no Discord account linked for that player ID. */
  | { status: 'no_discord_user' }
  /** The user doesn't accept direct messages from the bot. */
  | { status: 'dm_refused' }
  | { status: 'undeliverable'; reason: string }
  | { status: 'expired' };

export interface OutgoingMessage {
  playerId: string;
  /** Plain, at most 1,800 characters. The channel adds nothing to it. */
  text: string;
  /** Sealed at rest; may carry a secret. */
  link?: { label: string; url: string };
  expiresAt: Date;
  /** The sending feature's own name for it; never sent to Genie. Results come back to that topic's handler. */
  topic: string;
  /** The sender's own id for it, handed back to its topic's handler. */
  ref?: string;
}

/**
 * The feature-blind channel to Discord through Tournament Genie (ADR-0015 §7): a caller sends a message to a player ID
 * and gets a delivery result back. It knows nothing about the features that use it.
 */
export interface DiscordChannel {
  /**
   * Queues the message; resolves once Genie reports a result, or with `'pending'` when `waitMs` passes first.
   * @throws MessagingError `genie_unavailable` when `available()` is false; nothing is queued then.
   */
  send(msg: OutgoingMessage, opts: { waitMs: number; sender: string }): Promise<{ messageId: number; result: DeliveryResult | 'pending' }>;
  /**
   * The topic's handler, run for every final result inside the transaction that records it, whether or not `send`
   * was still waiting. A handler that throws rolls the result back.
   */
  onResult(topic: string, handler: (ref: string | undefined, result: DeliveryResult) => void): void;
  /** A pending message is not handed out again after this. Runs no handler. */
  cancel(messageId: number): void;
  /** False when Genie hasn't polled in the last 2 minutes. */
  available(): boolean;
}

/** A message as Genie's poll receives it: no topic, ref or sender. */
export interface MessageV1 {
  id: number;
  playerId: string;
  text: string;
  link: { label: string; url: string } | null;
  /** ISO. */
  expiresAt: string;
}

export type ReportedStatus = 'delivered' | 'no_discord_user' | 'dm_refused' | 'failed';

/** What the integrations routes and the plugins use: Genie's side of the channel, and its lifecycle. */
export interface MessageWire {
  /**
   * Hands out up to `limit` due messages, waiting up to `waitMs` for one when none is due. A token holds one waiting
   * poll at a time; a second answers at once. `signal` aborting (the client went away) ends the wait.
   * @throws MessagingError `shutting_down`
   */
  poll(leagueId: string, tokenId: number, opts: { waitMs: number; limit: number; signal?: AbortSignal }): Promise<MessageV1[]>;
  /** Records Genie's report on a message. @throws MessagingError `message_not_found` */
  report(leagueId: string, messageId: number, result: { status: ReportedStatus; reason?: string }): void;
}

export type MessagingService = DiscordChannel &
  MessageWire & {
    /** Boot: hands every final message whose handler hasn't run to its topic's handler. Returns how many. */
    replayUnhandled(): number;
    /** The hourly task: expires pending messages past their expiry and deletes messages older than 30 days. */
    expire(): { expired: number; deleted: number };
    /** Shutdown: waiting polls answer empty, waiting sends resolve `'pending'`, new polls are refused. Idempotent. */
    drain(): void;
  };

export interface MessagingDeps {
  db: Db;
  /** The message vault (its own key), for the links. */
  vault: StringVault;
  /** The league this install runs; every message belongs to it. */
  leagueId: string;
  now?: () => Date;
  log?: Pick<Logger, 'info' | 'warn'>;
}

/** The message vault's AAD for a message's link: a ciphertext only opens on its own row. */
export const messageAad = (id: number) => `outbound_message:${id}`;

const MAX_TEXT = 1800;
const MAX_LINK_LABEL = 60;
/** Genie counts as connected this long after its last poll. */
const AVAILABLE_FOR_MS = 120_000;
/** A message handed out is hidden this long, so another poll doesn't get it while Genie is sending it. */
const HIDE_MS = 60_000;
/** The 5th failure Genie reports makes a message undeliverable. */
const MAX_ATTEMPTS = 5;
const FIRST_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 3_600_000;
/** Rows are deleted this long after they were created, because the text can hold names. */
const KEEP_MS = 30 * 24 * 3_600_000;

type Row = typeof outboundMessage.$inferSelect;

interface SendWaiter {
  resolve: (result: DeliveryResult | 'pending') => void;
}

interface PollWaiter {
  leagueId: string;
  tokenId: number;
  limit: number;
  /** Tries to hand out messages; answers and returns true when it got any. */
  wake(): boolean;
  /** Ends the wait with nothing. */
  end(): void;
}

/** The result a final row records, for replaying its handler. */
function resultOf(r: Row): DeliveryResult {
  if (r.status === 'undeliverable') return { status: 'undeliverable', reason: r.statusReason ?? 'failed' };
  return { status: r.status as Exclude<DeliveryResult['status'], 'undeliverable'> };
}

export function createMessagingService(deps: MessagingDeps): MessagingService {
  const { db, vault } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;

  const lastPoll = new Map<string, number>();
  const handlers = new Map<string, (ref: string | undefined, result: DeliveryResult) => void>();
  const sendWaiters = new Map<number, SendWaiter>();
  const pollWaiters = new Set<PollWaiter>();
  let draining = false;

  const load = (id: number): Row | undefined => db.select().from(outboundMessage).where(eq(outboundMessage.id, id)).get();

  /**
   * Records a final result, its link's deletion, the topic's handler and `handled_at`, all or nothing: a handler that
   * throws rolls the result back. `extra` carries the failure count for an `undeliverable` from Genie's reports.
   */
  function finish(r: Row, result: DeliveryResult, extra: { attempts?: number } = {}): void {
    const at = now();
    db.transaction(() => {
      db.update(outboundMessage)
        .set({
          status: result.status,
          statusReason: result.status === 'undeliverable' ? result.reason : r.statusReason,
          attempts: extra.attempts ?? r.attempts,
          linkCiphertext: null,
          deliveredAt: result.status === 'delivered' ? at : null,
          handledAt: at,
        })
        .where(eq(outboundMessage.id, r.id))
        .run();
      handlers.get(r.topic)?.(r.ref ?? undefined, result);
    });
    log.info('outbound message finished', { messageId: r.id, status: result.status });
    const waiter = sendWaiters.get(r.id);
    sendWaiters.delete(r.id);
    waiter?.resolve(result);
  }

  /** The link, or `undefined` when the message vault can't open it (its key changed). */
  function openLink(r: Row): MessageV1['link'] | undefined {
    if (!r.linkCiphertext || r.linkLabel === null) return null;
    try {
      return { label: r.linkLabel, url: vault.decrypt(r.linkCiphertext, messageAad(r.id)) };
    } catch (err) {
      if (err instanceof VaultError) return undefined;
      throw err;
    }
  }

  /** Pending messages past their expiry become `expired`, each with its handler. Returns how many. */
  function expirePending(leagueId?: string): number {
    const at = now();
    const late = db
      .select()
      .from(outboundMessage)
      .where(and(eq(outboundMessage.status, 'pending'), lte(outboundMessage.expiresAt, at), leagueId ? eq(outboundMessage.leagueId, leagueId) : undefined))
      .all();
    for (const r of late) finish(r, { status: 'expired' });
    return late.length;
  }

  /** Selects due messages and hides each for `HIDE_MS` in the same write, so no other poll gets it meanwhile. */
  function handOut(leagueId: string, limit: number): MessageV1[] {
    expirePending(leagueId);
    const at = now();
    const handed: MessageV1[] = [];
    const unreadable: Row[] = [];
    db.transaction(() => {
      const due = db
        .select()
        .from(outboundMessage)
        .where(and(eq(outboundMessage.leagueId, leagueId), eq(outboundMessage.status, 'pending'), lte(outboundMessage.nextAttemptAt, at)))
        .orderBy(asc(outboundMessage.id))
        .limit(limit)
        .all();
      for (const r of due) {
        const link = openLink(r);
        if (link === undefined) {
          unreadable.push(r);
          continue;
        }
        db.update(outboundMessage)
          .set({ nextAttemptAt: new Date(at.getTime() + HIDE_MS) })
          .where(eq(outboundMessage.id, r.id))
          .run();
        handed.push({ id: r.id, playerId: r.playerId, text: r.text, link, expiresAt: r.expiresAt.toISOString() });
      }
    });
    for (const r of unreadable) {
      log.warn('An outbound message link no longer decrypts (the message vault key changed); it is undeliverable.', { messageId: r.id });
      finish(r, { status: 'undeliverable', reason: 'link_unreadable' });
    }
    for (const m of handed) log.info('outbound message handed out', { messageId: m.id });
    return handed;
  }

  /** Wakes the league's waiting polls; each takes what it can, and one that finds nothing keeps waiting. */
  function wakePolls(leagueId: string): void {
    for (const w of [...pollWaiters]) if (w.leagueId === leagueId) w.wake();
  }

  const service: MessagingService = {
    available() {
      const last = lastPoll.get(deps.leagueId);
      return last !== undefined && now().getTime() - last <= AVAILABLE_FOR_MS;
    },

    async send(msg, { waitMs, sender }) {
      if (msg.text.length > MAX_TEXT) throw new Error(`A message's text is at most 1,800 characters (got ${msg.text.length}).`);
      if (msg.link && msg.link.label.length > MAX_LINK_LABEL) throw new Error(`A message's link label is at most 60 characters.`);
      if (!service.available()) {
        throw new MessagingError('genie_unavailable', "Genie isn't connected, so the message can't be delivered.");
      }
      const at = now();
      const id = db.transaction(() => {
        const { id } = db
          .insert(outboundMessage)
          .values({
            leagueId: deps.leagueId,
            playerId: msg.playerId,
            text: msg.text,
            topic: msg.topic,
            ref: msg.ref ?? null,
            linkLabel: msg.link?.label ?? null,
            status: 'pending',
            nextAttemptAt: at,
            createdBy: sender,
            createdAt: at,
            expiresAt: msg.expiresAt,
          })
          .returning({ id: outboundMessage.id })
          .get();
        if (msg.link) {
          db.update(outboundMessage)
            .set({ linkCiphertext: vault.encrypt(msg.link.url, messageAad(id)) })
            .where(eq(outboundMessage.id, id))
            .run();
        }
        return id;
      });
      wakePolls(deps.leagueId);

      if (waitMs <= 0 || draining) return { messageId: id, result: 'pending' };
      const result = await new Promise<DeliveryResult | 'pending'>((resolve) => {
        const timer = setTimeout(() => {
          sendWaiters.delete(id);
          resolve('pending');
        }, waitMs);
        sendWaiters.set(id, {
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
        });
      });
      return { messageId: id, result };
    },

    onResult(topic, handler) {
      handlers.set(topic, handler);
    },

    cancel(messageId) {
      db.update(outboundMessage)
        .set({ status: 'cancelled', linkCiphertext: null })
        .where(and(eq(outboundMessage.id, messageId), eq(outboundMessage.status, 'pending')))
        .run();
    },

    async poll(leagueId, tokenId, { waitMs, limit, signal }) {
      if (draining) throw new MessagingError('shutting_down', 'The app is stopping. Poll again once it is back.');
      lastPoll.set(leagueId, now().getTime());
      const ready = handOut(leagueId, limit);
      const alreadyWaiting = [...pollWaiters].some((w) => w.leagueId === leagueId && w.tokenId === tokenId);
      if (ready.length > 0 || waitMs <= 0 || alreadyWaiting || signal?.aborted) return ready;

      return new Promise<MessageV1[]>((resolve) => {
        const done = (messages: MessageV1[]) => {
          clearTimeout(timer);
          pollWaiters.delete(waiter);
          signal?.removeEventListener('abort', onAbort);
          resolve(messages);
        };
        const waiter: PollWaiter = {
          leagueId,
          tokenId,
          limit,
          wake() {
            const got = handOut(leagueId, limit);
            if (got.length === 0) return false;
            done(got);
            return true;
          },
          end: () => done([]),
        };
        const onAbort = () => waiter.end();
        const timer = setTimeout(() => waiter.end(), waitMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        pollWaiters.add(waiter);
      });
    },

    report(leagueId, messageId, { status, reason }) {
      const r = load(messageId);
      if (!r || r.leagueId !== leagueId) throw new MessagingError('message_not_found', `No message ${messageId}.`);
      if (r.status !== 'pending') return;
      log.info('outbound message result', { messageId, status });
      if (status !== 'failed') {
        finish(r, { status });
        return;
      }
      const attempts = r.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        finish(r, { status: 'undeliverable', reason: reason ?? 'failed' }, { attempts });
        return;
      }
      const backoff = Math.min(FIRST_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
      db.update(outboundMessage)
        .set({ attempts, statusReason: reason ?? null, nextAttemptAt: new Date(now().getTime() + backoff) })
        .where(eq(outboundMessage.id, r.id))
        .run();
    },

    replayUnhandled() {
      const unhandled = db
        .select()
        .from(outboundMessage)
        .where(and(ne(outboundMessage.status, 'pending'), ne(outboundMessage.status, 'cancelled'), isNull(outboundMessage.handledAt)))
        .all();
      for (const r of unhandled) finish(r, resultOf(r));
      return unhandled.length;
    },

    expire() {
      const expired = expirePending();
      const cutoff = new Date(now().getTime() - KEEP_MS);
      const deleted = db.delete(outboundMessage).where(lt(outboundMessage.createdAt, cutoff)).returning({ id: outboundMessage.id }).all().length;
      return { expired, deleted };
    },

    drain() {
      draining = true;
      for (const w of [...pollWaiters]) w.end();
      for (const [id, waiter] of sendWaiters) {
        sendWaiters.delete(id);
        waiter.resolve('pending');
      }
    },
  };

  return service;
}
