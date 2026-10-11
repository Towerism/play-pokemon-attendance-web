import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { pokemonConnection } from '../../db/schema';
import { createPkcePair, createState, parseCallbackUrl } from './adapters/ptc-oauth/pkce';
import { PokemonUpstreamError } from './ports/errors';
import type { League, PlayToolsGateway } from './ports/play-tools-gateway';
import type { PtcOAuthClient, TokenGrant } from './ports/ptc-oauth';
import type { AccessToken, ConnectionStatus, TokenProvider } from './ports/token-provider';
import { type TokenVault, TokenVaultError } from './vault/vault';

/** What the Settings page shows. Never carries a token. */
export interface ConnectionView {
  status: ConnectionStatus;
  /** Why a reconnect is needed; null otherwise. */
  reason: string | null;
  connectedAt: Date | null;
  lastRefreshedAt: Date | null;
  /** The upstream league attendance goes to; null until chosen. */
  league: League | null;
}

export type KeepAliveResult =
  | { outcome: 'refreshed' | 'skipped_recent' | 'not_connected' | 'needs_reconnect' }
  | { outcome: 'failed'; message: string };

export type ConnectErrorCode =
  /** The pasted text is not a play-tools `loggedIn?code=…&state=…` URL. */
  | 'invalid_url'
  /** The state was not issued here for this user, or was already used. */
  | 'unknown_attempt'
  /** Older than the 10-minute window. */
  | 'expired'
  /** Pokémon refused the code (already redeemed, too old, verifier mismatch). */
  | 'code_rejected';

export class ConnectError extends Error {
  override name = 'ConnectError';
  constructor(
    readonly code: ConnectErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class LeagueNotFoundError extends Error {
  override name = 'LeagueNotFoundError';
  constructor(activityGroupId: string) {
    super(`League ${activityGroupId} is not one of the connected Pokémon account's leagues.`);
  }
}

export interface PokemonConnectionService extends TokenProvider {
  getStatus(leagueId: string): ConnectionView;
  /** Begins a connect for `userId`: the attempt (PKCE verifier + state) lives 10 minutes, in memory only. */
  startConnect(leagueId: string, userId: number): { authorizeUrl: string; expiresAt: Date };
  /** @throws ConnectError, PokemonUpstreamError */
  completeConnect(leagueId: string, userId: number, pastedUrl: string): Promise<ConnectionView>;
  listUpstreamLeagues(leagueId: string): Promise<{ leagues: League[]; selectedId: string | null }>;
  /** @throws LeagueNotFoundError, PokemonUpstreamError */
  selectLeague(leagueId: string, activityGroupId: string): Promise<ConnectionView>;
  /** Rotates the refresh token if the last refresh is ≥ 45 min old, so the chain never ages out. Never throws. */
  keepAlive(leagueId: string): Promise<KeepAliveResult>;
  /** Revokes at Hydra (best effort) and forgets the stored token. */
  disconnect(leagueId: string): Promise<{ revoked: boolean }>;
}

export interface PokemonConnectionDeps {
  db: Db;
  vault: TokenVault;
  oauth: PtcOAuthClient;
  /** League discovery through the play-tools adapter, authorised by this service. */
  gateway: (tokens: TokenProvider, leagueId: string) => Pick<PlayToolsGateway, 'listLeagues'>;
  now?: () => Date;
  log?: { warn(message: string): void };
}

const ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 20;
/** ADR-0003: a cached access token is used while it has at least this long left. */
const MIN_VALIDITY_MS = 2 * 60_000;
// Under the hourly schedule, so a slightly late run still refreshes.
const KEEPALIVE_AFTER_MS = 45 * 60_000;

interface Attempt {
  leagueId: string;
  userId: number;
  verifier: string;
  expiresAt: number;
}

type Row = typeof pokemonConnection.$inferSelect;

/**
 * The pokemon-connection module (ADR-0003): the one-time connect, the
 * encrypted refresh token, and `TokenProvider`. Refreshes are serialised per
 * league, and a rotated refresh token is written to the database before the
 * new access token is handed to anyone: Hydra revokes the whole chain when an
 * old refresh token is replayed.
 */
export function createPokemonConnectionService(deps: PokemonConnectionDeps): PokemonConnectionService {
  const { db, vault, oauth } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? { warn: (message: string) => console.warn(message) };

  const attempts = new Map<string, Attempt>();
  const accessTokens = new Map<string, AccessToken>();
  const locks = new Map<string, Promise<unknown>>();

  function withLock<T>(leagueId: string, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(leagueId) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => undefined);
    locks.set(leagueId, settled);
    void settled.then(() => {
      if (locks.get(leagueId) === settled) locks.delete(leagueId);
    });
    return run;
  }

  const load = (leagueId: string): Row | undefined =>
    db.select().from(pokemonConnection).where(eq(pokemonConnection.leagueId, leagueId)).get();

  function view(r: Row | undefined): ConnectionView {
    if (!r) return { status: 'not_connected', reason: null, connectedAt: null, lastRefreshedAt: null, league: null };
    return {
      status: r.status,
      reason: r.statusReason,
      connectedAt: r.connectedAt,
      lastRefreshedAt: r.lastRefreshedAt,
      league: r.activityGroupId
        ? {
            id: r.activityGroupId,
            name: r.activityGroupName ?? r.activityGroupId,
            displayId: r.activityGroupDisplayId,
            canSubmit: r.activityGroupCanSubmit === true,
          }
        : null,
    };
  }

  const fresh = (token: AccessToken | undefined): token is AccessToken =>
    token !== undefined && token.expiresAt.getTime() - now().getTime() >= MIN_VALIDITY_MS;

  const toAccessToken = (grant: TokenGrant): AccessToken => ({
    value: grant.accessToken,
    expiresAt: grant.expiresAt,
    subject: grant.subject,
  });

  function markNeedsReconnect(leagueId: string, reason: string): PokemonUpstreamError {
    accessTokens.delete(leagueId);
    db.update(pokemonConnection)
      .set({ status: 'needs_reconnect', statusReason: reason })
      .where(eq(pokemonConnection.leagueId, leagueId))
      .run();
    return new PokemonUpstreamError('needs_reconnect', reason);
  }

  /** Caller holds the league's lock. */
  async function refresh(r: Row): Promise<AccessToken> {
    if (r.status === 'needs_reconnect') {
      throw new PokemonUpstreamError('needs_reconnect', r.statusReason ?? 'Reconnect the Pokémon account in Settings.');
    }
    let current: string;
    try {
      current = vault.decrypt(r.refreshTokenCiphertext, r.leagueId);
    } catch (err) {
      if (!(err instanceof TokenVaultError)) throw err;
      throw markNeedsReconnect(
        r.leagueId,
        'The saved Pokémon login cannot be decrypted: the token vault key changed. Reconnect the Pokémon account.',
      );
    }

    let grant: TokenGrant;
    try {
      grant = await oauth.refresh(current);
    } catch (err) {
      if (err instanceof PokemonUpstreamError && err.code === 'needs_reconnect') throw markNeedsReconnect(r.leagueId, err.message);
      throw err;
    }

    // Persist the rotated token first; if this throws, the access token is never handed out.
    db.update(pokemonConnection)
      .set({ refreshTokenCiphertext: vault.encrypt(grant.refreshToken ?? current, r.leagueId), lastRefreshedAt: now() })
      .where(eq(pokemonConnection.leagueId, r.leagueId))
      .run();
    const token = toAccessToken(grant);
    accessTokens.set(r.leagueId, token);
    return token;
  }

  function requireRow(leagueId: string): Row {
    const r = load(leagueId);
    if (!r) throw new PokemonUpstreamError('not_connected', 'No Pokémon account is connected. Connect one in Settings.');
    return r;
  }

  const service: PokemonConnectionService = {
    getStatus: (leagueId) => view(load(leagueId)),

    getAccessToken(leagueId) {
      const cached = accessTokens.get(leagueId);
      if (fresh(cached)) return Promise.resolve(cached);
      return withLock(leagueId, async () => {
        const again = accessTokens.get(leagueId);
        if (fresh(again)) return again;
        return refresh(requireRow(leagueId));
      });
    },

    startConnect(leagueId, userId) {
      const at = now().getTime();
      for (const [state, a] of attempts) if (a.expiresAt < at) attempts.delete(state);
      while (attempts.size >= MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value!);

      const { verifier, challenge } = createPkcePair();
      const state = createState();
      const expiresAt = at + ATTEMPT_TTL_MS;
      attempts.set(state, { leagueId, userId, verifier, expiresAt });
      return { authorizeUrl: oauth.authorizeUrl(challenge, state), expiresAt: new Date(expiresAt) };
    },

    async completeConnect(leagueId, userId, pastedUrl) {
      const parsed = parseCallbackUrl(pastedUrl);
      if (!parsed.ok) throw new ConnectError('invalid_url', parsed.error);

      const attempt = attempts.get(parsed.state);
      if (!attempt || attempt.leagueId !== leagueId || attempt.userId !== userId) {
        throw new ConnectError('unknown_attempt', 'This login was not started here, or was already used. Start the connection again.');
      }
      attempts.delete(parsed.state);
      if (now().getTime() > attempt.expiresAt) {
        throw new ConnectError('expired', 'This login took longer than 10 minutes. Start the connection again.');
      }

      await withLock(leagueId, async () => {
        let grant: TokenGrant;
        try {
          grant = await oauth.exchangeCode(parsed.code, attempt.verifier);
        } catch (err) {
          if (err instanceof PokemonUpstreamError && err.code === 'needs_reconnect') {
            throw new ConnectError('code_rejected', `${err.message}. Start the connection again.`);
          }
          throw err;
        }
        if (!grant.refreshToken) {
          throw new PokemonUpstreamError('unexpected_shape', 'Pokémon did not grant offline access (no refresh token).');
        }

        const previous = load(leagueId);
        const sameAccount = previous?.ptcUserId === grant.subject;
        const values = {
          ptcUserId: grant.subject,
          refreshTokenCiphertext: vault.encrypt(grant.refreshToken, leagueId),
          status: 'connected' as const,
          statusReason: null,
          connectedAt: now(),
          lastRefreshedAt: now(),
          ...(sameAccount
            ? {}
            : { activityGroupId: null, activityGroupName: null, activityGroupDisplayId: null, activityGroupCanSubmit: null }),
        };
        db.insert(pokemonConnection)
          .values({ leagueId, ...values })
          .onConflictDoUpdate({ target: pokemonConnection.leagueId, set: values })
          .run();
        accessTokens.set(leagueId, toAccessToken(grant));
      });

      if (!load(leagueId)?.activityGroupId) await autoSelectLeague(leagueId);
      return view(load(leagueId));
    },

    async listUpstreamLeagues(leagueId) {
      requireRow(leagueId);
      const leagues = await deps.gateway(service, leagueId).listLeagues();
      return { leagues, selectedId: load(leagueId)?.activityGroupId ?? null };
    },

    async selectLeague(leagueId, activityGroupId) {
      const { leagues } = await service.listUpstreamLeagues(leagueId);
      const chosen = leagues.find((l) => l.id === activityGroupId);
      if (!chosen) throw new LeagueNotFoundError(activityGroupId);
      bind(leagueId, chosen);
      return view(load(leagueId));
    },

    keepAlive(leagueId) {
      return withLock(leagueId, async (): Promise<KeepAliveResult> => {
        const r = load(leagueId);
        if (!r) return { outcome: 'not_connected' };
        if (r.status === 'needs_reconnect') return { outcome: 'needs_reconnect' };
        if (now().getTime() - r.lastRefreshedAt.getTime() < KEEPALIVE_AFTER_MS) return { outcome: 'skipped_recent' };
        try {
          await refresh(r);
          return { outcome: 'refreshed' };
        } catch (err) {
          if (err instanceof PokemonUpstreamError && err.code === 'needs_reconnect') return { outcome: 'needs_reconnect' };
          return { outcome: 'failed', message: (err as Error).message };
        }
      });
    },

    disconnect(leagueId) {
      return withLock(leagueId, async () => {
        const r = load(leagueId);
        accessTokens.delete(leagueId);
        if (!r) return { revoked: false };

        let revoked = false;
        try {
          await oauth.revoke(vault.decrypt(r.refreshTokenCiphertext, leagueId));
          revoked = true;
        } catch (err) {
          log.warn(`[pokemon] Could not revoke the refresh token at Pokémon; forgetting it locally anyway (${(err as Error).message}).`);
        }
        db.delete(pokemonConnection).where(eq(pokemonConnection.leagueId, leagueId)).run();
        return { revoked };
      });
    },
  };

  function bind(leagueId: string, league: League): void {
    db.update(pokemonConnection)
      .set({
        activityGroupId: league.id,
        activityGroupName: league.name,
        activityGroupDisplayId: league.displayId,
        activityGroupCanSubmit: league.canSubmit,
      })
      .where(eq(pokemonConnection.leagueId, leagueId))
      .run();
  }

  /** After a connect: an organizer with exactly one league needs no choice. Discovery failures don't fail the connect. */
  async function autoSelectLeague(leagueId: string): Promise<void> {
    try {
      const leagues = await deps.gateway(service, leagueId).listLeagues();
      if (leagues.length === 1) bind(leagueId, leagues[0]!);
    } catch (err) {
      log.warn(`[pokemon] League discovery after connecting failed; pick the league in Settings (${(err as Error).message}).`);
    }
  }

  return service;
}
