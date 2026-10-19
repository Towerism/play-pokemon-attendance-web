import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { type Logger, silentLogger } from '@towerism/selfhost-kit';
import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { appInvite, appUser } from '../../db/schema';
import type { DeliveryResult, DiscordChannel } from '../messaging/channel';
import { MessagingError } from '../messaging/errors';
import { inviteMessage, resetMessage } from './messages';
import type { Actor, AppUser, PasswordHasher } from './service';

/** The install's one budget (ADR-0015 §6): the owner's connections, active professors and open invites. */
export const MAX_SEATS = 10;
const PREFIX = 'ppa_inv_';
const LIFETIME_MS = 72 * 3_600_000;
const TOPIC = 'invite';

export type InviteErrorCode =
  /** 10 seats are used. */
  | 'invite_limit'
  /** Unknown, malformed, expired, used or revoked: always the same refusal. */
  | 'invite_invalid'
  | 'invite_used'
  | 'invite_not_found'
  | 'username_taken'
  | 'username_required'
  | 'professor_not_found'
  /** A reset by Discord for a professor with no connection, or one whose player ID isn't known yet. */
  | 'no_recipient'
  /** Send by Discord needs `NUXT_PUBLIC_SITE_URL`: a LAN address is no use to someone at home. */
  | 'site_url_not_set'
  /** Genie's final refusal within the wait; the link was revoked. */
  | 'no_discord_user'
  | 'dm_refused'
  | 'undeliverable';

export class InviteError extends Error {
  override name = 'InviteError';
  constructor(
    readonly code: InviteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type Delivery = 'sending' | 'delivered' | 'no_discord_user' | 'dm_refused' | 'undeliverable' | 'expired';

/** An invite or reset link as the owner sees it: never its secret or hash. */
export interface InviteView {
  id: number;
  kind: 'invite' | 'reset';
  label: string | null;
  /** The bound player ID of an invite, or whom a reset link went to by Discord. */
  playerId: string | null;
  /** The professor a reset link is for. */
  username: string | null;
  hint: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  delivery: Delivery | null;
}

/** A copied link carries its secret (and the full link when the site URL is set); a Discord send carries neither. */
export interface MintResult {
  invite: InviteView;
  secret?: string;
  link?: string | null;
}

export interface InviteCheck {
  kind: 'invite' | 'reset';
  label: string | null;
  leagueName: string | null;
  expiresAt: string;
  username: string | null;
}

export interface InviteService {
  /**
   * Mints an invite (ADR-0015 §6). With `send: 'discord'` it goes to the bound player ID through Genie, waiting for the
   * result. @throws MessagingError `genie_unavailable`; InviteError `site_url_not_set`, `invite_limit`, and the refusals
   */
  mint(owner: Actor, input: { label?: string; playerId?: string; send: 'copy' | 'discord' }): Promise<MintResult>;
  /** Mints a password reset link for a professor (ADR-0015 §8), revoking any earlier open one. Takes no seat. */
  mintReset(owner: Actor, userId: number, send: 'copy' | 'discord'): Promise<MintResult>;
  /** @throws InviteError `invite_not_found`, `invite_used` */
  revoke(id: number): void;
  /** Revokes a professor's open reset links and cancels their messages (removal). Runs inside the caller's transaction. */
  revokeResetLinksOf(userId: number): void;
  /** @throws InviteError `invite_invalid` */
  check(secret: string): InviteCheck;
  /** Creates the professor, or sets the reset professor's password. @throws InviteError */
  accept(input: { secret: string; username?: string; password: string }): Promise<AppUser>;
  /** Open invites and reset links (not used, revoked or expired), newest first. */
  openInvites(): InviteView[];
  seatsUsed(): number;
  /** The player ID the invite a professor accepted binds them to, or null. */
  boundPlayerId(userId: number): string | null;
}

export interface InviteDeps {
  db: Db;
  hasher: PasswordHasher;
  channel: DiscordChannel;
  /** The pokemon module's view of connections, through its exported service. */
  connections: { ownerConnectionCount(): number; recipientOf(userId: number): string | null };
  leagueId: string;
  /** The league's activity group name, or null until the owner picks one. */
  leagueName: () => string | null;
  timeZone: string;
  /** `NUXT_PUBLIC_SITE_URL`, or null when it isn't set. */
  siteUrl: string | null;
  /** How long Send by Discord waits for Genie (`NUXT_MESSAGING_SEND_WAIT_MS`). */
  sendWaitMs: number;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  log?: Pick<Logger, 'info'>;
}

type Row = typeof appInvite.$inferSelect;

const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const invalid = () => new InviteError('invite_invalid', "This link doesn't work. It may have expired, been used or been revoked.");

export function createInviteService(deps: InviteDeps): InviteService {
  const { db, channel } = deps;
  const now = deps.now ?? (() => new Date());
  const randomBytes = deps.randomBytes ?? cryptoRandomBytes;
  const log = deps.log ?? silentLogger;
  const siteUrl = deps.siteUrl ? deps.siteUrl.replace(/\/+$/, '') : null;

  const isOpen = (r: Row, at = now()) => r.revokedAt === null && r.acceptedAt === null && r.expiresAt.getTime() > at.getTime();
  const load = (id: number): Row | undefined => db.select().from(appInvite).where(eq(appInvite.id, id)).get();
  const usernameOf = (userId: number | null) =>
    userId === null ? null : (db.select({ username: appUser.username }).from(appUser).where(eq(appUser.id, userId)).get()?.username ?? null);

  const view = (r: Row): InviteView => ({
    id: r.id,
    kind: r.forUserId === null ? 'invite' : 'reset',
    label: r.label,
    playerId: r.forPlayerId,
    username: usernameOf(r.forUserId),
    hint: r.secretHint,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    delivery: r.delivery,
  });

  function activeProfessor(userId: number) {
    return db
      .select()
      .from(appUser)
      .where(and(eq(appUser.id, userId), eq(appUser.role, 'professor'), isNull(appUser.removedAt)))
      .get();
  }

  function seatsUsed(): number {
    const at = now();
    const professors = db
      .select({ n: count() })
      .from(appUser)
      .where(and(eq(appUser.role, 'professor'), isNull(appUser.removedAt)))
      .get()!.n;
    const open = db
      .select({ n: count() })
      .from(appInvite)
      .where(and(isNull(appInvite.forUserId), isNull(appInvite.revokedAt), isNull(appInvite.acceptedAt), gt(appInvite.expiresAt, at)))
      .get()!.n;
    return deps.connections.ownerConnectionCount() + professors + open;
  }

  /** Revokes and cancels, for an open link. */
  function close(r: Row, at: Date): void {
    db.update(appInvite).set({ revokedAt: at }).where(eq(appInvite.id, r.id)).run();
    if (r.messageId !== null) channel.cancel(r.messageId);
  }

  // Every final result for an invite's message (ADR-0015 §7; D3, D4): a refusal revokes the link, because it never
  // reached the invitee. Runs inside the transaction that records the result.
  channel.onResult(TOPIC, (ref, result: DeliveryResult) => {
    const r = ref === undefined ? undefined : load(Number(ref));
    if (!r) return;
    const refused = result.status === 'no_discord_user' || result.status === 'dm_refused' || result.status === 'undeliverable';
    db.update(appInvite)
      .set({ delivery: result.status, revokedAt: refused && isOpen(r) ? now() : r.revokedAt })
      .where(eq(appInvite.id, r.id))
      .run();
    log.info('invite delivery', { inviteId: r.id, delivery: result.status });
  });

  /** Inserts a link row; returns it with its secret. */
  function insert(owner: Actor, values: { label?: string | null; forPlayerId?: string | null; forUserId?: number | null; delivery?: Delivery | null }) {
    const secret = PREFIX + randomBytes(32).toString('base64url');
    const at = now();
    const row = db
      .insert(appInvite)
      .values({
        leagueId: deps.leagueId,
        secretHash: digest(secret),
        secretHint: `${PREFIX}…${secret.slice(-4)}`,
        label: values.label ?? null,
        forPlayerId: values.forPlayerId ?? null,
        forUserId: values.forUserId ?? null,
        createdBy: owner.username,
        createdAt: at,
        expiresAt: new Date(at.getTime() + LIFETIME_MS),
        delivery: values.delivery ?? null,
      })
      .returning()
      .get();
    return { row, secret };
  }

  /** Discord's preconditions, in ADR-0015 §6's order, before anything is written. */
  function checkDiscord(): string {
    if (!channel.available()) throw new MessagingError('genie_unavailable', "Genie isn't connected. Copy the link instead.");
    if (!siteUrl) throw new InviteError('site_url_not_set', 'Set the site URL (NUXT_PUBLIC_SITE_URL) to send links by Discord.');
    return siteUrl;
  }

  /** Sends a minted link through Genie and maps the result; a refusal was already applied by the topic handler. */
  async function deliver(owner: Actor, row: Row, secret: string, playerId: string, words: { text: string; linkLabel: string }, site: string): Promise<MintResult> {
    let sent: Awaited<ReturnType<DiscordChannel['send']>>;
    try {
      sent = await channel.send(
        { playerId, text: words.text, link: { label: words.linkLabel, url: `${site}/invite#${secret}` }, expiresAt: row.expiresAt, topic: TOPIC, ref: String(row.id) },
        { waitMs: deps.sendWaitMs, sender: owner.username },
      );
    } catch (err) {
      // Genie went quiet between the check and the send: the link was never handed to anyone.
      if (err instanceof MessagingError) db.delete(appInvite).where(eq(appInvite.id, row.id)).run();
      throw err;
    }
    db.update(appInvite).set({ messageId: sent.messageId }).where(eq(appInvite.id, row.id)).run();
    const latest = load(row.id)!;
    // Revoked or used while the send waited: the message can't be cancelled before it has an id, so cancel it now.
    if (sent.result === 'pending' && !isOpen(latest)) channel.cancel(sent.messageId);

    const result = sent.result === 'pending' ? undefined : sent.result.status;
    if (result === 'no_discord_user') throw new InviteError('no_discord_user', `Genie has no Discord account linked for player ${playerId}. Ask them to link it in Genie, or copy the link instead.`);
    if (result === 'dm_refused') throw new InviteError('dm_refused', `Player ${playerId} doesn't accept direct messages from Genie.`);
    if (result === 'undeliverable') throw new InviteError('undeliverable', "Genie couldn't deliver the link.");
    return { invite: view(load(row.id)!) };
  }

  const copied = (row: Row, secret: string): MintResult => ({ invite: view(row), secret, link: siteUrl && `${siteUrl}/invite#${secret}` });

  return {
    async mint(owner, { label, playerId, send }) {
      if (send === 'discord' && !playerId) throw new Error('Send by Discord needs a bound player ID.');
      const site = send === 'discord' ? checkDiscord() : null;
      const { row, secret } = db.transaction(
        () => {
          if (seatsUsed() >= MAX_SEATS) {
            throw new InviteError('invite_limit', `All ${MAX_SEATS} places are taken by your Pokémon accounts, professors and open invites. Revoke an invite or remove a professor first.`);
          }
          return insert(owner, { label, forPlayerId: playerId, delivery: send === 'discord' ? 'sending' : null });
        },
        { behavior: 'immediate' },
      );
      log.info('invite minted', { inviteId: row.id, kind: 'invite', playerId: playerId ?? null, by: owner.username });
      if (site === null) return copied(row, secret);
      return deliver(owner, row, secret, playerId!, inviteMessage({ owner: owner.username, leagueName: deps.leagueName(), expiresAt: row.expiresAt, timeZone: deps.timeZone }), site);
    },

    async mintReset(owner, userId, send) {
      const professor = activeProfessor(userId);
      if (!professor) throw new InviteError('professor_not_found', `No professor ${userId}.`);
      const site = send === 'discord' ? checkDiscord() : null;
      const recipient = send === 'discord' ? deps.connections.recipientOf(userId) : null;
      if (send === 'discord' && !recipient) {
        throw new InviteError('no_recipient', `${professor.username} has no Pokémon account connected, so Genie can't find them. Copy the link instead.`);
      }
      const { row, secret } = db.transaction(
        () => {
          const at = now();
          for (const r of db.select().from(appInvite).where(eq(appInvite.forUserId, userId)).all()) if (isOpen(r, at)) close(r, at);
          return insert(owner, { forUserId: userId, forPlayerId: recipient, delivery: site ? 'sending' : null });
        },
        { behavior: 'immediate' },
      );
      log.info('invite minted', { inviteId: row.id, kind: 'reset', username: professor.username, by: owner.username });
      if (site === null) return copied(row, secret);
      return deliver(owner, row, secret, recipient!, resetMessage({ owner: owner.username, username: professor.username, expiresAt: row.expiresAt, timeZone: deps.timeZone }), site);
    },

    revoke(id) {
      const r = load(id);
      if (!r) throw new InviteError('invite_not_found', `No invite ${id}.`);
      if (r.acceptedAt !== null) throw new InviteError('invite_used', 'This invite was already used, so it can no longer be revoked.');
      if (!isOpen(r)) return;
      close(r, now());
      log.info('invite revoked', { inviteId: id });
    },

    revokeResetLinksOf(userId) {
      const at = now();
      for (const r of db.select().from(appInvite).where(eq(appInvite.forUserId, userId)).all()) if (isOpen(r, at)) close(r, at);
    },

    check(secret) {
      const r = db.select().from(appInvite).where(eq(appInvite.secretHash, digest(secret))).get();
      if (!r || !isOpen(r) || (r.forUserId !== null && !activeProfessor(r.forUserId))) throw invalid();
      return { kind: r.forUserId === null ? 'invite' : 'reset', label: r.label, leagueName: deps.leagueName(), expiresAt: r.expiresAt.toISOString(), username: usernameOf(r.forUserId) };
    },

    async accept({ secret, username, password }) {
      const hash = digest(secret);
      const first = db.select().from(appInvite).where(eq(appInvite.secretHash, hash)).get();
      if (!first || !isOpen(first)) throw invalid();
      if (first.forUserId === null && !username) throw new InviteError('username_required', 'Choose a username.');
      const passwordHash = await deps.hasher.hash(password);

      // Re-check inside a write transaction: the link may have been used or revoked while we hashed.
      const accepted = db.transaction(
        () => {
          const r = db.select().from(appInvite).where(eq(appInvite.secretHash, hash)).get();
          const at = now();
          if (!r || !isOpen(r, at)) throw invalid();
          let user: AppUser;
          if (r.forUserId === null) {
            if (db.select({ id: appUser.id }).from(appUser).where(eq(appUser.username, username!)).get()) {
              throw new InviteError('username_taken', `The username ${username} is taken. Choose another.`);
            }
            user = db
              .insert(appUser)
              .values({ username: username!, passwordHash, role: 'professor', lastSignInAt: at, createdAt: at })
              .returning({ id: appUser.id, username: appUser.username })
              .get();
          } else {
            const professor = activeProfessor(r.forUserId);
            if (!professor) throw invalid();
            db.update(appUser).set({ passwordHash, reverifyRequiredAt: at, lastSignInAt: at }).where(eq(appUser.id, professor.id)).run();
            user = { id: professor.id, username: professor.username };
          }
          db.update(appInvite).set({ acceptedAt: at, acceptedUserId: user.id }).where(eq(appInvite.id, r.id)).run();
          if (r.messageId !== null) channel.cancel(r.messageId);
          return { user, inviteId: r.id, kind: r.forUserId === null ? 'invite' : 'reset' };
        },
        { behavior: 'immediate' },
      );
      log.info('invite accepted', { inviteId: accepted.inviteId, kind: accepted.kind, username: accepted.user.username });
      return accepted.user;
    },

    openInvites() {
      const at = now();
      return db
        .select()
        .from(appInvite)
        .where(and(isNull(appInvite.revokedAt), isNull(appInvite.acceptedAt), gt(appInvite.expiresAt, at)))
        .orderBy(desc(appInvite.createdAt), desc(appInvite.id))
        .all()
        .map(view);
    },

    seatsUsed,

    boundPlayerId(userId) {
      return (
        db
          .select({ playerId: appInvite.forPlayerId })
          .from(appInvite)
          .where(and(eq(appInvite.acceptedUserId, userId), isNull(appInvite.forUserId)))
          .get()?.playerId ?? null
      );
    },
  };
}
