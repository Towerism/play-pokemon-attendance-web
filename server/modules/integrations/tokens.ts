import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { and, count, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { integrationToken } from '../../db/schema';
import { IntegrationError } from './errors';

/** Tokens a league may hold at once. */
export const MAX_TOKENS_PER_LEAGUE = 10;
const PREFIX = 'ppa_int_';

/** What a token may do (ADR-0013, amended by ADR-0015 §7): read the day, and/or deliver the Discord channel's messages. */
export const INTEGRATION_SCOPES = ['integrations:read', 'messages:deliver'] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

/** Each scope once, in `INTEGRATION_SCOPES` order. */
const normalized = (scopes: readonly IntegrationScope[]): IntegrationScope[] => INTEGRATION_SCOPES.filter((s) => scopes.includes(s));
const parsed = (stored: string): IntegrationScope[] => normalized(stored.split(' ') as IntegrationScope[]);

/** A token as the organizer sees it: never its secret or hash. */
export interface IntegrationTokenView {
  id: number;
  label: string;
  /** `ppa_int_…` plus the secret's last 4 characters. */
  hint: string;
  createdBy: string;
  /** ISO. */
  createdAt: string;
  /** ISO; null until a call authenticates with it. */
  lastUsedAt: string | null;
  scopes: IntegrationScope[];
}

/** Who a live secret belongs to. */
export interface AuthenticatedToken {
  id: number;
  leagueId: string;
  label: string;
  scopes: IntegrationScope[];
}

export interface IntegrationTokenService {
  /**
   * Mints a token with `scopes` (default `integrations:read`). The secret (`ppa_int_` + 43 base64url characters, 256 random bits) is returned here only;
   * the database keeps its SHA-256.
   * @throws IntegrationError `token_limit`
   */
  create(leagueId: string, label: string, by: string, scopes?: readonly IntegrationScope[]): { token: IntegrationTokenView; secret: string };
  /** The league's tokens, newest first. */
  list(leagueId: string): IntegrationTokenView[];
  /** Deletes the token, so its secret stops working at once. @throws IntegrationError `not_found` */
  revoke(leagueId: string, id: number): void;
  /** The live token a secret belongs to, or null. Looked up by digest; never marks it used. */
  authenticate(secret: string | undefined): AuthenticatedToken | null;
  /** Records a call the token authenticated. */
  markUsed(id: number): void;
}

export interface IntegrationTokenDeps {
  db: Db;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
}

const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');

export function createIntegrationTokenService(deps: IntegrationTokenDeps): IntegrationTokenService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const randomBytes = deps.randomBytes ?? cryptoRandomBytes;

  type Row = typeof integrationToken.$inferSelect;
  const toView = (r: Row): IntegrationTokenView => ({
    id: r.id,
    label: r.label,
    hint: r.tokenHint,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    scopes: parsed(r.scopes),
  });

  return {
    create(leagueId, label, by, scopes = ['integrations:read']) {
      const secret = PREFIX + randomBytes(32).toString('base64url');
      return db.transaction(() => {
        const held = db.select({ n: count() }).from(integrationToken).where(eq(integrationToken.leagueId, leagueId)).get()!.n;
        if (held >= MAX_TOKENS_PER_LEAGUE) {
          throw new IntegrationError('token_limit', `A league can hold at most ${MAX_TOKENS_PER_LEAGUE} integration tokens. Revoke one first.`);
        }
        const row = db
          .insert(integrationToken)
          .values({
            leagueId,
            label,
            tokenHash: digest(secret),
            tokenHint: `${PREFIX}…${secret.slice(-4)}`,
            scopes: normalized(scopes).join(' '),
            createdBy: by,
            createdAt: now(),
          })
          .returning()
          .get();
        return { token: toView(row), secret };
      });
    },

    list(leagueId) {
      return db
        .select()
        .from(integrationToken)
        .where(eq(integrationToken.leagueId, leagueId))
        .orderBy(desc(integrationToken.createdAt), desc(integrationToken.id))
        .all()
        .map(toView);
    },

    revoke(leagueId, id) {
      const gone = db
        .delete(integrationToken)
        .where(and(eq(integrationToken.id, id), eq(integrationToken.leagueId, leagueId)))
        .returning({ id: integrationToken.id })
        .get();
      if (!gone) throw new IntegrationError('not_found', `No integration token ${id}.`);
    },

    authenticate(secret) {
      if (!secret) return null;
      const row = db.select().from(integrationToken).where(eq(integrationToken.tokenHash, digest(secret))).get();
      return row ? { id: row.id, leagueId: row.leagueId, label: row.label, scopes: parsed(row.scopes) } : null;
    },

    markUsed(id) {
      db.update(integrationToken).set({ lastUsedAt: now() }).where(eq(integrationToken.id, id)).run();
    },
  };
}
