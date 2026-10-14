import { type Logger, type StringVault, VaultError, silentLogger } from '@towerism/selfhost-kit';
import { asc, count, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { leagueUpstream, pokemonConnection } from '../../db/schema';
import { createPkcePair, createState, parseCallbackUrl } from './adapters/ptc-oauth/pkce';
import { PokemonUpstreamError } from './ports/errors';
import type { League, PlayToolsGateway, ProfessorProfile } from './ports/play-tools-gateway';
import type { PtcOAuthClient, TokenGrant } from './ports/ptc-oauth';
import type { AccessToken, ConnectionStatus, TokenProvider } from './ports/token-provider';

/** One professor's connection, as Settings lists it. Never carries a token. */
export interface ProfessorConnection {
  id: number;
  /** Null only for a connection carried over from v1 that hasn't been identified yet. */
  professorPlayerId: string | null;
  professorName: string | null;
  /** The professor's full name for TDFs (ADR-0011 decision 8): set by the organizer, never from Pokémon. */
  professorFullName: string | null;
  status: 'connected' | 'needs_reconnect';
  /** Why a reconnect is needed; null otherwise. */
  reason: string | null;
  connectedAt: Date;
  lastRefreshedAt: Date;
  /** This professor's connection makes the league's upstream calls. */
  submitsForLeague: boolean;
}

/** The league's side: whose connection submits for it, and where to. Never carries a token. */
export interface ConnectionView {
  /** The submitting connection's status; `connected` with no league while professors are connected but none is chosen. */
  status: ConnectionStatus;
  reason: string | null;
  connectedAt: Date | null;
  lastRefreshedAt: Date | null;
  /** The upstream league attendance goes to; null until chosen. */
  league: League | null;
  /** The submitting connection; null until chosen. */
  connectionId: number | null;
  professor: { playerId: string | null; name: string | null } | null;
}

/** A connection as staffing and submission see it: whose it is and whether it can act. Never carries a token. */
export interface ActingConnection {
  id: number;
  professorPlayerId: string | null;
  professorName: string | null;
  status: 'connected' | 'needs_reconnect';
}

/** The leagues every connected professor shares (#75), as the named professor sees them. */
export interface SharedLeagues {
  leagues: League[];
  /** The league's activity group when the named professor submits for it. */
  selectedId: string | null;
  /** Professors left out of the shared set because they need a reconnect. */
  excluded: { playerId: string | null; name: string | null }[];
}

export type KeepAliveResult =
  | { outcome: 'refreshed' | 'skipped_recent' | 'not_connected' | 'needs_reconnect' }
  | { outcome: 'failed'; message: string };

export type KeepAliveReport = { connectionId: number; professorPlayerId: string | null } & KeepAliveResult;

export type ConnectErrorCode =
  /** The pasted text is not a play-tools `loggedIn?code=…&state=…` URL. */
  | 'invalid_url'
  /** The state was not issued here for this user, or was already used. */
  | 'unknown_attempt'
  /** Older than the 10-minute window. */
  | 'expired'
  /** Pokémon refused the code (already redeemed, too old, verifier mismatch). */
  | 'code_rejected'
  /** The account has no player id upstream (no personal activity group owner). */
  | 'profile_unavailable'
  /** Pokémon could not be reached while identifying the professor. */
  | 'upstream_unavailable'
  /** Already `MAX_CONNECTIONS` professors, and this is a new one. */
  | 'connection_limit';

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
    super(`League ${activityGroupId} is not one of that professor's leagues.`);
  }
}

export class ConnectionNotFoundError extends Error {
  override name = 'ConnectionNotFoundError';
  constructor(professorPlayerId: string) {
    super(`No Pokémon account is connected for professor ${professorPlayerId}.`);
  }
}

export interface PokemonConnectionService extends TokenProvider {
  getStatus(leagueId: string): ConnectionView;
  listConnections(leagueId: string): ProfessorConnection[];
  /** Every connection, oldest first, for reading and acting as each professor (#75). */
  listActingConnections(): ActingConnection[];
  /** Begins a connect for `userId`: the attempt (PKCE verifier + state) lives 10 minutes, in memory only. */
  startConnect(userId: number): { authorizeUrl: string; expiresAt: Date };
  /** Adds the professor the pasted login belongs to, or reconnects them. @throws ConnectError, PokemonUpstreamError */
  completeConnect(leagueId: string, userId: number, pastedUrl: string): Promise<{ connection: ProfessorConnection; outcome: 'added' | 'reconnected' }>;
  /**
   * Sets a professor's display name (ADR-0008: display only, never from or to Pokémon), full name (ADR-0011 decision 8:
   * set by the organizer, never from Pokémon), or both. A name left out stays as it is; null clears it.
   * @throws ConnectionNotFoundError
   */
  renameProfessor(leagueId: string, professorPlayerId: string, names: { name?: string | null; fullName?: string | null }): ProfessorConnection;
  /**
   * The leagues every connected professor shares (#75), each read as that professor. A professor who needs a
   * reconnect is left out and named; any other failure throws, so a league is never chosen from a partial set.
   * @throws ConnectionNotFoundError, PokemonUpstreamError
   */
  listUpstreamLeagues(leagueId: string, professorPlayerId: string): Promise<SharedLeagues>;
  /** Makes that professor's connection submit for the league, to a league every professor shares. @throws ConnectionNotFoundError, LeagueNotFoundError, PokemonUpstreamError */
  selectLeague(leagueId: string, professorPlayerId: string, activityGroupId: string): Promise<ConnectionView>;
  /** Rotates each refresh token whose last refresh is ≥ 45 min old, one connection at a time. Never throws. */
  keepAliveAll(): Promise<KeepAliveReport[]>;
  /** Revokes at Hydra (best effort) and forgets that professor; the league forgets them too if they submitted for it. @throws ConnectionNotFoundError */
  disconnect(leagueId: string, professorPlayerId: string): Promise<{ revoked: boolean }>;
  /** Boot, before any refresh: re-seals tokens still sealed with the league id (v1) under their own row. Returns how many. */
  resealCarriedOver(leagueId: string): number;
  /** Boot: refreshes connected, unidentified connections so they learn their professor. Never throws. */
  identifyCarriedOver(): Promise<void>;
}

export interface PokemonConnectionDeps {
  db: Db;
  vault: StringVault;
  oauth: PtcOAuthClient;
  /** League discovery and identity through the play-tools adapter, authorised as the given connection. */
  gateway: (tokens: TokenProvider, connectionId: number) => Pick<PlayToolsGateway, 'listLeagues' | 'getProfessorProfile'>;
  now?: () => Date;
  log?: Pick<Logger, 'warn'>;
}

/** The token vault's AAD for a connection's refresh token: a ciphertext only opens on its own row (ADR-0008). */
export const connectionAad = (id: number) => `pokemon_connection:${id}`;

const ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 20;
/** ADR-0008: at most this many professors per install. */
export const MAX_CONNECTIONS = 10;
/** ADR-0003: a cached access token is used while it has at least this long left. */
const MIN_VALIDITY_MS = 2 * 60_000;
// Under the hourly schedule, so a slightly late run still refreshes.
const KEEPALIVE_AFTER_MS = 45 * 60_000;

interface Attempt {
  userId: number;
  verifier: string;
  expiresAt: number;
}

type Row = typeof pokemonConnection.$inferSelect;
type Binding = typeof leagueUpstream.$inferSelect;

/**
 * The pokemon-connection module (ADR-0003, ADR-0008): one connection per
 * professor, each with its own encrypted refresh token, and `TokenProvider`.
 * Refreshes are serialised per connection, and a rotated refresh token is
 * written to the database before the new access token is handed to anyone:
 * Hydra revokes the whole chain when an old refresh token is replayed.
 */
export function createPokemonConnectionService(deps: PokemonConnectionDeps): PokemonConnectionService {
  const { db, vault, oauth } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;

  const attempts = new Map<string, Attempt>();
  const accessTokens = new Map<number, AccessToken>();
  const locks = new Map<number, Promise<unknown>>();

  function withLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(id) ?? Promise.resolve()).then(fn);
    const settled = run.catch(() => undefined);
    locks.set(id, settled);
    void settled.then(() => {
      if (locks.get(id) === settled) locks.delete(id);
    });
    return run;
  }

  const load = (id: number): Row | undefined => db.select().from(pokemonConnection).where(eq(pokemonConnection.id, id)).get();
  const loadByPlayer = (playerId: string): Row | undefined =>
    db.select().from(pokemonConnection).where(eq(pokemonConnection.professorPlayerId, playerId)).get();
  const all = (): Row[] => db.select().from(pokemonConnection).orderBy(asc(pokemonConnection.id)).all();
  const bindingOf = (leagueId: string): Binding | undefined => db.select().from(leagueUpstream).where(eq(leagueUpstream.leagueId, leagueId)).get();

  function requireByPlayer(playerId: string): Row {
    const r = loadByPlayer(playerId);
    if (!r) throw new ConnectionNotFoundError(playerId);
    return r;
  }

  const leagueOf = (b: Binding): League => ({
    id: b.activityGroupId,
    name: b.activityGroupName,
    displayId: b.activityGroupDisplayId,
    canSubmit: b.activityGroupCanSubmit,
  });

  function professorView(r: Row, b: Binding | undefined): ProfessorConnection {
    return {
      id: r.id,
      professorPlayerId: r.professorPlayerId,
      professorName: r.professorName,
      professorFullName: r.professorFullName,
      status: r.status,
      reason: r.statusReason,
      connectedAt: r.connectedAt,
      lastRefreshedAt: r.lastRefreshedAt,
      submitsForLeague: b?.connectionId === r.id,
    };
  }

  function leagueView(leagueId: string): ConnectionView {
    const b = bindingOf(leagueId);
    const r = b && load(b.connectionId);
    if (!b || !r) {
      const anyone = db.select({ n: count() }).from(pokemonConnection).get()!.n > 0;
      return {
        status: anyone ? 'connected' : 'not_connected',
        reason: null,
        connectedAt: null,
        lastRefreshedAt: null,
        league: null,
        connectionId: null,
        professor: null,
      };
    }
    return {
      status: r.status,
      reason: r.statusReason,
      connectedAt: r.connectedAt,
      lastRefreshedAt: r.lastRefreshedAt,
      league: leagueOf(b),
      connectionId: r.id,
      professor: { playerId: r.professorPlayerId, name: r.professorName },
    };
  }

  const fresh = (token: AccessToken | undefined): token is AccessToken =>
    token !== undefined && token.expiresAt.getTime() - now().getTime() >= MIN_VALIDITY_MS;

  const toAccessToken = (grant: TokenGrant): AccessToken => ({
    value: grant.accessToken,
    expiresAt: grant.expiresAt,
    subject: grant.subject,
  });

  /** A TokenProvider that hands out one known token, for calls made before or while a connection is (re)written. */
  const fixedToken = (token: AccessToken): TokenProvider => ({ getAccessToken: () => Promise.resolve(token) });

  function markNeedsReconnect(id: number, reason: string): PokemonUpstreamError {
    accessTokens.delete(id);
    db.update(pokemonConnection).set({ status: 'needs_reconnect', statusReason: reason }).where(eq(pokemonConnection.id, id)).run();
    return new PokemonUpstreamError('needs_reconnect', reason);
  }

  function open(r: Row): string {
    try {
      return vault.decrypt(r.refreshTokenCiphertext, connectionAad(r.id));
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      throw markNeedsReconnect(r.id, 'The saved Pokémon login cannot be decrypted: the token vault key changed. Reconnect the Pokémon account.');
    }
  }

  async function revokeQuietly(refreshToken: string): Promise<boolean> {
    try {
      await oauth.revoke(refreshToken);
      return true;
    } catch (err) {
      log.warn(`Could not revoke the refresh token at Pokémon; forgetting it locally anyway (${(err as Error).message}).`, { err });
      return false;
    }
  }

  /** Caller holds the connection's lock. */
  async function refresh(r: Row): Promise<AccessToken> {
    if (r.status === 'needs_reconnect') {
      throw new PokemonUpstreamError('needs_reconnect', r.statusReason ?? 'Reconnect the Pokémon account in Settings.');
    }
    const current = open(r);

    let grant: TokenGrant;
    try {
      grant = await oauth.refresh(current);
    } catch (err) {
      if (err instanceof PokemonUpstreamError && err.code === 'needs_reconnect') throw markNeedsReconnect(r.id, err.message);
      throw err;
    }

    // Persist the rotated token first; if this throws, the access token is never handed out.
    db.update(pokemonConnection)
      .set({ refreshTokenCiphertext: vault.encrypt(grant.refreshToken ?? current, connectionAad(r.id)), lastRefreshedAt: now() })
      .where(eq(pokemonConnection.id, r.id))
      .run();
    const token = toAccessToken(grant);
    accessTokens.set(r.id, token);
    if (r.professorPlayerId === null) await fillIdentity(r.id, token);
    return token;
  }

  /** After a refresh: learn which professor a carried-over connection belongs to. Failures wait for the next refresh. */
  async function fillIdentity(id: number, token: AccessToken): Promise<void> {
    let profile: ProfessorProfile;
    try {
      profile = await deps.gateway(fixedToken(token), id).getProfessorProfile();
    } catch (err) {
      log.warn(`Could not read the professor's identity from Pokémon; trying again on the next refresh (${(err as Error).message}).`, { err });
      return;
    }
    const r = load(id);
    if (!r) return;
    if (r.professorPlayerId === null) {
      const twin = loadByPlayer(profile.playerId);
      if (twin) {
        await mergeInto(twin, r);
        return;
      }
    }
    db.update(pokemonConnection).set({ professorPlayerId: profile.playerId }).where(eq(pokemonConnection.id, id)).run();
  }

  /** A carried-over connection turned out to be a professor who is already connected: keep theirs, and the league binding. */
  async function mergeInto(kept: Row, dropped: Row): Promise<void> {
    const token = open(dropped);
    db.transaction((tx) => {
      tx.update(leagueUpstream).set({ connectionId: kept.id }).where(eq(leagueUpstream.connectionId, dropped.id)).run();
      tx.delete(pokemonConnection).where(eq(pokemonConnection.id, dropped.id)).run();
    });
    accessTokens.delete(dropped.id);
    await revokeQuietly(token);
  }

  function bind(leagueId: string, connectionId: number, league: League): void {
    const values = {
      connectionId,
      activityGroupId: league.id,
      activityGroupName: league.name,
      activityGroupDisplayId: league.displayId,
      activityGroupCanSubmit: league.canSubmit,
    };
    db.insert(leagueUpstream).values({ leagueId, ...values }).onConflictDoUpdate({ target: leagueUpstream.leagueId, set: values }).run();
  }

  /** Writes a completed connect: reconnects the professor's row, claims a carried-over one, or adds a row under the cap. */
  function persistConnect(grant: TokenGrant & { refreshToken: string }, profile: ProfessorProfile): { id: number; outcome: 'added' | 'reconnected' } {
    return db.transaction((tx) => {
      const at = now();
      const fields = { ptcUserId: grant.subject, status: 'connected' as const, statusReason: null, connectedAt: at, lastRefreshedAt: at };
      const seal = (id: number) => vault.encrypt(grant.refreshToken, connectionAad(id));

      const own = tx.select().from(pokemonConnection).where(eq(pokemonConnection.professorPlayerId, profile.playerId)).get();
      const carried = tx
        .select()
        .from(pokemonConnection)
        .where(isNull(pokemonConnection.professorPlayerId))
        .all()
        .find((r) => r.status === 'needs_reconnect' || r.ptcUserId === grant.subject);
      const target = own ?? carried;
      if (target) {
        tx.update(pokemonConnection)
          .set({ ...fields, professorPlayerId: profile.playerId, refreshTokenCiphertext: seal(target.id) })
          .where(eq(pokemonConnection.id, target.id))
          .run();
        return { id: target.id, outcome: 'reconnected' as const };
      }

      if (tx.select({ n: count() }).from(pokemonConnection).get()!.n >= MAX_CONNECTIONS) {
        throw new ConnectError('connection_limit', `Already ${MAX_CONNECTIONS} Pokémon accounts are connected. Disconnect one first.`);
      }
      const { id } = tx
        .insert(pokemonConnection)
        .values({ ...fields, professorPlayerId: profile.playerId, refreshTokenCiphertext: Buffer.alloc(0) })
        .returning({ id: pokemonConnection.id })
        .get();
      tx.update(pokemonConnection).set({ refreshTokenCiphertext: seal(id) }).where(eq(pokemonConnection.id, id)).run();
      return { id, outcome: 'added' as const };
    });
  }

  async function identify(token: AccessToken, refreshToken: string): Promise<ProfessorProfile> {
    try {
      return await deps.gateway(fixedToken(token), 0).getProfessorProfile();
    } catch (err) {
      await revokeQuietly(refreshToken);
      if (err instanceof PokemonUpstreamError && err.code === 'unexpected_shape') {
        throw new ConnectError('profile_unavailable', `Pokémon did not say which professor this account belongs to (${err.message}).`);
      }
      throw new ConnectError('upstream_unavailable', `Pokémon could not be reached to identify the professor (${(err as Error).message}). Start the connection again.`);
    }
  }

  /** The leagues `named` shares with every other professor; those needing a reconnect are left out (#75). */
  async function sharedLeagues(named: Row): Promise<{ leagues: League[]; excluded: SharedLeagues['excluded'] }> {
    let leagues = await deps.gateway(service, named.id).listLeagues();
    const excluded: SharedLeagues['excluded'] = [];
    for (const other of all()) {
      if (other.id === named.id) continue;
      const leaveOut = () => excluded.push({ playerId: other.professorPlayerId, name: other.professorName });
      if (other.status === 'needs_reconnect') {
        leaveOut();
        continue;
      }
      let theirs: League[];
      try {
        theirs = await deps.gateway(service, other.id).listLeagues();
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError && err.code === 'needs_reconnect')) throw err;
        leaveOut();
        continue;
      }
      const ids = new Set(theirs.map((l) => l.id));
      leagues = leagues.filter((l) => ids.has(l.id));
    }
    return { leagues, excluded };
  }

  /** After a connect: a league with no submitting professor takes this one when exactly one league is shared. */
  async function autoSelectLeague(leagueId: string, id: number): Promise<void> {
    if (bindingOf(leagueId)) return;
    try {
      const { leagues } = await sharedLeagues(load(id)!);
      if (leagues.length === 1) bind(leagueId, id, leagues[0]!);
    } catch (err) {
      log.warn(`League discovery after connecting failed; pick the league in Settings (${(err as Error).message}).`, { err });
    }
  }

  async function keepAlive(id: number): Promise<KeepAliveResult> {
    return withLock(id, async (): Promise<KeepAliveResult> => {
      const r = load(id);
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
  }

  const service: PokemonConnectionService = {
    getStatus: (leagueId) => leagueView(leagueId),

    listConnections(leagueId) {
      const b = bindingOf(leagueId);
      // Named professors first, by name; then the rest by player id.
      const named = (r: Row) => (r.professorName === null ? 1 : 0);
      return all()
        .sort(
          (x, y) =>
            named(x) - named(y) ||
            (x.professorName ?? '').localeCompare(y.professorName ?? '') ||
            (x.professorPlayerId ?? '').localeCompare(y.professorPlayerId ?? ''),
        )
        .map((r) => professorView(r, b));
    },

    getAccessToken(id) {
      const cached = accessTokens.get(id);
      if (fresh(cached)) return Promise.resolve(cached);
      return withLock(id, async () => {
        const again = accessTokens.get(id);
        if (fresh(again)) return again;
        const r = load(id);
        if (!r) throw new PokemonUpstreamError('not_connected', 'No Pokémon account is connected. Connect one in Settings.');
        return refresh(r);
      });
    },

    startConnect(userId) {
      const at = now().getTime();
      for (const [state, a] of attempts) if (a.expiresAt < at) attempts.delete(state);
      while (attempts.size >= MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value!);

      const { verifier, challenge } = createPkcePair();
      const state = createState();
      const expiresAt = at + ATTEMPT_TTL_MS;
      attempts.set(state, { userId, verifier, expiresAt });
      return { authorizeUrl: oauth.authorizeUrl(challenge, state), expiresAt: new Date(expiresAt) };
    },

    async completeConnect(leagueId, userId, pastedUrl) {
      const parsed = parseCallbackUrl(pastedUrl);
      if (!parsed.ok) throw new ConnectError('invalid_url', parsed.error);

      const attempt = attempts.get(parsed.state);
      if (!attempt || attempt.userId !== userId) {
        throw new ConnectError('unknown_attempt', 'This login was not started here, or was already used. Start the connection again.');
      }
      attempts.delete(parsed.state);
      if (now().getTime() > attempt.expiresAt) {
        throw new ConnectError('expired', 'This login took longer than 10 minutes. Start the connection again.');
      }

      let grant: TokenGrant;
      try {
        grant = await oauth.exchangeCode(parsed.code, attempt.verifier);
      } catch (err) {
        if (err instanceof PokemonUpstreamError && err.code === 'needs_reconnect') {
          throw new ConnectError('code_rejected', `${err.message}. Start the connection again.`);
        }
        throw err;
      }
      const refreshToken = grant.refreshToken;
      if (!refreshToken) throw new PokemonUpstreamError('unexpected_shape', 'Pokémon did not grant offline access (no refresh token).');

      // Nothing has rotated yet, so reading the identity with the new access token before storing the chain can't revoke it.
      const token = toAccessToken(grant);
      const profile = await identify(token, refreshToken);

      const write = () => {
        try {
          const done = persistConnect({ ...grant, refreshToken }, profile);
          accessTokens.set(done.id, token);
          return done;
        } catch (err) {
          if (err instanceof ConnectError) void revokeQuietly(refreshToken);
          throw err;
        }
      };
      const own = loadByPlayer(profile.playerId);
      const { id, outcome } = own ? await withLock(own.id, async () => write()) : write();

      await autoSelectLeague(leagueId, id);
      return { connection: professorView(load(id)!, bindingOf(leagueId)), outcome };
    },

    renameProfessor(leagueId, professorPlayerId, { name, fullName }) {
      const r = requireByPlayer(professorPlayerId);
      // Drizzle leaves an undefined field out of the update, so a name that wasn't sent stays as it is.
      if (name !== undefined || fullName !== undefined) {
        db.update(pokemonConnection)
          .set({ professorName: name, professorFullName: fullName })
          .where(eq(pokemonConnection.id, r.id))
          .run();
      }
      return professorView(load(r.id)!, bindingOf(leagueId));
    },

    listActingConnections: () =>
      all().map((r) => ({ id: r.id, professorPlayerId: r.professorPlayerId, professorName: r.professorName, status: r.status })),

    async listUpstreamLeagues(leagueId, professorPlayerId) {
      const r = requireByPlayer(professorPlayerId);
      const { leagues, excluded } = await sharedLeagues(r);
      const b = bindingOf(leagueId);
      return { leagues, selectedId: b?.connectionId === r.id ? b.activityGroupId : null, excluded };
    },

    async selectLeague(leagueId, professorPlayerId, activityGroupId) {
      const r = requireByPlayer(professorPlayerId);
      const { leagues } = await service.listUpstreamLeagues(leagueId, professorPlayerId);
      const chosen = leagues.find((l) => l.id === activityGroupId);
      if (!chosen) throw new LeagueNotFoundError(activityGroupId);
      bind(leagueId, r.id, chosen);
      return leagueView(leagueId);
    },

    async keepAliveAll() {
      const reports: KeepAliveReport[] = [];
      for (const r of all()) reports.push({ connectionId: r.id, professorPlayerId: r.professorPlayerId, ...(await keepAlive(r.id)) });
      return reports;
    },

    async disconnect(_leagueId, professorPlayerId) {
      const r = requireByPlayer(professorPlayerId);
      return withLock(r.id, async () => {
        accessTokens.delete(r.id);
        let revoked = false;
        try {
          revoked = await revokeQuietly(vault.decrypt(r.refreshTokenCiphertext, connectionAad(r.id)));
        } catch (err) {
          if (!(err instanceof VaultError)) throw err;
        }
        db.delete(pokemonConnection).where(eq(pokemonConnection.id, r.id)).run();
        return { revoked };
      });
    },

    resealCarriedOver(leagueId) {
      let resealed = 0;
      for (const r of all()) {
        try {
          vault.decrypt(r.refreshTokenCiphertext, connectionAad(r.id));
          continue;
        } catch (err) {
          if (!(err instanceof VaultError)) throw err;
        }
        let token: string;
        try {
          token = vault.decrypt(r.refreshTokenCiphertext, leagueId);
        } catch (err) {
          if (!(err instanceof VaultError)) throw err;
          continue; // a lost key or a foreign ciphertext: the first use marks it needs_reconnect
        }
        db.update(pokemonConnection)
          .set({ refreshTokenCiphertext: vault.encrypt(token, connectionAad(r.id)) })
          .where(eq(pokemonConnection.id, r.id))
          .run();
        resealed += 1;
      }
      return resealed;
    },

    async identifyCarriedOver() {
      for (const r of all()) {
        if (r.professorPlayerId !== null || r.status !== 'connected') continue;
        await withLock(r.id, async () => {
          const again = load(r.id);
          if (!again || again.professorPlayerId !== null) return;
          await refresh(again);
        }).catch((err: unknown) => {
          log.warn(`Could not refresh a carried-over Pokémon connection at boot (${(err as Error).message}).`, { err });
        });
      }
    },
  };

  return service;
}
