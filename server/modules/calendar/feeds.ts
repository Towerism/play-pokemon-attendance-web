import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { and, eq, gte, isNull, lte, or } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { calendarFeed } from '../../db/schema';

const PREFIX = 'ppa_cal_';
/** `ppa_cal_` plus 43 base64url characters (256 random bits); anything else is refused before a digest is computed. */
const SECRET = /^ppa_cal_[A-Za-z0-9_-]{43}$/;
/** `last_read_at` is written at most this often per feed (ADR-0016 §1). */
const READ_MARK_MS = 60_000;

/** Which feed: the league's public feed, or one user's own. */
export type FeedRef = { kind: 'public' } | { kind: 'user'; userId: number };

/** A feed as its holder sees it: never its secret or digest. */
export interface FeedView {
  /** `ppa_cal_…` plus the secret's last 4 characters. */
  hint: string;
  /** ISO; when the current secret was minted. */
  createdAt: string;
  /** ISO; null until a fetch is answered. */
  lastReadAt: string | null;
}

/** The feed a secret matched. */
export interface MatchedFeed {
  id: number;
  leagueId: string;
  kind: 'public' | 'user';
  userId: number | null;
  lastReadAt: Date | null;
}

export interface FeedStore {
  /**
   * Turns the feed on, or rotates it when it is on: a new secret replaces the old one in the same row, so the old link
   * stops working on its next fetch. The secret is returned here only; the database keeps its SHA-256.
   */
  mint(leagueId: string, ref: FeedRef): { secret: string; feed: FeedView; created: boolean };
  view(leagueId: string, ref: FeedRef): FeedView | null;
  /** Deletes the feed; nothing happens when it is already off. */
  turnOff(leagueId: string, ref: FeedRef): void;
  /** Deletes every feed of a removed user (ADR-0016 §1). Runs inside the caller's transaction. */
  deleteUserFeeds(userId: number): void;
  /** The feed a well-formed secret belongs to, or null. Looked up by digest through the unique index. */
  find(secret: string | null | undefined): MatchedFeed | null;
  /** Records a fetch it answered, at most once a minute. */
  markRead(id: number): void;
  /** Leagues with a feed read, created or rotated at or after `since` (ADR-0016 §5: the hourly refresh's leagues). */
  leaguesInUse(since: Date): string[];
}

export interface FeedStoreDeps {
  db: Db;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
}

const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');

export function createFeedStore(deps: FeedStoreDeps): FeedStore {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const randomBytes = deps.randomBytes ?? cryptoRandomBytes;

  type Row = typeof calendarFeed.$inferSelect;
  const toView = (r: Row): FeedView => ({
    hint: r.hint,
    createdAt: r.createdAt.toISOString(),
    lastReadAt: r.lastReadAt?.toISOString() ?? null,
  });
  const where = (leagueId: string, ref: FeedRef) =>
    ref.kind === 'public'
      ? and(eq(calendarFeed.leagueId, leagueId), eq(calendarFeed.kind, 'public'))
      : and(eq(calendarFeed.leagueId, leagueId), eq(calendarFeed.kind, 'user'), eq(calendarFeed.userId, ref.userId));

  return {
    mint(leagueId, ref) {
      const secret = PREFIX + randomBytes(32).toString('base64url');
      const values = { tokenSha256: digest(secret), hint: `${PREFIX}…${secret.slice(-4)}`, createdAt: now(), lastReadAt: null };
      return db.transaction(() => {
        const existing = db.select({ id: calendarFeed.id }).from(calendarFeed).where(where(leagueId, ref)).get();
        const row = existing
          ? db.update(calendarFeed).set(values).where(eq(calendarFeed.id, existing.id)).returning().get()
          : db
              .insert(calendarFeed)
              .values({ leagueId, kind: ref.kind, userId: ref.kind === 'user' ? ref.userId : null, ...values })
              .returning()
              .get();
        return { secret, feed: toView(row), created: !existing };
      });
    },

    view(leagueId, ref) {
      const row = db.select().from(calendarFeed).where(where(leagueId, ref)).get();
      return row ? toView(row) : null;
    },

    turnOff(leagueId, ref) {
      db.delete(calendarFeed).where(where(leagueId, ref)).run();
    },

    deleteUserFeeds(userId) {
      db.delete(calendarFeed).where(and(eq(calendarFeed.kind, 'user'), eq(calendarFeed.userId, userId))).run();
    },

    find(secret) {
      if (!secret || !SECRET.test(secret)) return null;
      const row = db.select().from(calendarFeed).where(eq(calendarFeed.tokenSha256, digest(secret))).get();
      return row ? { id: row.id, leagueId: row.leagueId, kind: row.kind, userId: row.userId, lastReadAt: row.lastReadAt } : null;
    },

    markRead(id) {
      const at = now();
      const due = new Date(at.getTime() - READ_MARK_MS);
      db.update(calendarFeed)
        .set({ lastReadAt: at })
        .where(and(eq(calendarFeed.id, id), or(isNull(calendarFeed.lastReadAt), lte(calendarFeed.lastReadAt, due))))
        .run();
    },

    leaguesInUse(since) {
      return db
        .selectDistinct({ leagueId: calendarFeed.leagueId })
        .from(calendarFeed)
        .where(or(gte(calendarFeed.lastReadAt, since), gte(calendarFeed.createdAt, since)))
        .all()
        .map((r) => r.leagueId);
    },
  };
}
