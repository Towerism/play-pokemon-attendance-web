import { type Logger, type StringVault, VaultError, silentLogger } from '@towerism/selfhost-kit';
import { asc, count, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { leagueMembership, leagueUpstream, pokemonConnection } from '../../db/schema';
import type { AccountsService, Actor } from '../accounts/service';
import { createPkcePair, createState, parseCallbackUrl } from './adapters/ptc-oauth/pkce';
import type { EndedLease, LeaseStore } from './leases';
import { PokemonUpstreamError } from './ports/errors';
import type { League, PlayToolsGateway, ProfessorProfile } from './ports/play-tools-gateway';
import type { PtcOAuthClient, TokenGrant } from './ports/ptc-oauth';
import type { AccessToken, TokenProvider } from './ports/token-provider';

/** Whether a connection's Pokémon account is in the league's activity group (ADR-0015 §3). */
export type MembershipStatus = 'member' | 'outside' | 'unknown';

/**
 * Why a professor sees only their own account (ADR-0015 §3, §8); null for a league member. `reverify_required`: they
 * accepted a password reset link and haven't completed a Pokémon connect since.
 */
export type WaitingReason = null | 'no_connection' | 'outside' | 'unknown' | 'reverify_required';

/** The league's upstream activity group (ADR-0015 §3): chosen by the owner, naming no connection. */
export interface UpstreamLeague {
  id: string;
  name: string;
  displayId: string | null;
}

/** A connection as staffing, submission and tournaments see it: whose it is and whether it can act. Never carries a token. */
export interface ActingConnection {
  id: number;
  professorPlayerId: string | null;
  professorName: string | null;
  status: 'connected' | 'needs_reconnect';
  /** The user who holds it (ADR-0015 §2). */
  userId: number;
  membership: MembershipStatus;
  /** A member allowed to record attendance for the league. */
  canSubmit: boolean;
}

/** One professor's connection, as Settings lists it for one viewer. Never carries a token. */
export interface ProfessorConnection extends ActingConnection {
  /** The professor's full name for TDFs (ADR-0011 decision 8): set by the holder, never from Pokémon. */
  professorFullName: string | null;
  /** Why a reconnect is needed; null otherwise. */
  reason: string | null;
  connectedAt: Date;
  lastRefreshedAt: Date;
  /** The viewer holds it. */
  mine: boolean;
}

/** The leagues the owner may choose from: those of the owner's own connections (ADR-0015 §3). */
export interface UpstreamLeagues {
  leagues: League[];
  /** The league's activity group, once chosen. */
  selectedId: string | null;
  /** Owner connections left out because they need a reconnect. */
  excluded: { playerId: string | null; name: string | null }[];
}

/**
 * What `actingConnection` checks (ADR-0015 §4): `own` is the holder's connection only (attendance, templates, creating,
 * editing and cancelling tournaments); `tournament` also honours a live lease on that tournament (§5).
 */
export type ActingScope = { kind: 'own' } | { kind: 'tournament'; tournamentId: string; use: 'staff' | 'results' };

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
  | 'connection_limit'
  /** Another user holds a connection for that Pokémon account, and it isn't the owner's going to a professor (ADR-0015 §2). */
  | 'connection_held'
  /** A professor who holds a connection logged in as a different Pokémon account (ADR-0015 §2). */
  | 'one_connection_only'
  /** A professor whose invite was bound to a player ID logged in as another Pokémon account (ADR-0015 §6). */
  | 'invite_player_mismatch';

export class ConnectError extends Error {
  override name = 'ConnectError';
  constructor(
    readonly code: ConnectErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Why `actingConnection` (or a holder-only change) refused: 409 for the first two, 403 for `not_your_connection` and
 * `reverify_required` (a professor who must prove their Pokémon login after a password reset, ADR-0015 §8).
 */
export type ConnectionAccessCode = 'organizer_not_connected' | 'needs_reconnect' | 'not_your_connection' | 'reverify_required';

export class ConnectionAccessError extends Error {
  override name = 'ConnectionAccessError';
  constructor(
    readonly code: ConnectionAccessCode,
    message: string,
    readonly professorPlayerId: string,
  ) {
    super(message);
  }
}

export class LeagueNotFoundError extends Error {
  override name = 'LeagueNotFoundError';
  constructor(activityGroupId: string) {
    super(`League ${activityGroupId} is not one of your Pokémon accounts' leagues.`);
  }
}

export class ConnectionNotFoundError extends Error {
  override name = 'ConnectionNotFoundError';
  constructor(professorPlayerId: string) {
    super(`No Pokémon account is connected for professor ${professorPlayerId}.`);
  }
}

/** A professor's connection, as Settings → Professors shows it to the owner. Never carries a token. */
export interface HeldConnection {
  playerId: string | null;
  name: string | null;
  status: 'connected' | 'needs_reconnect';
  membership: MembershipStatus;
  /** When it moved from the owner to this professor (ADR-0015 §2); null otherwise. */
  claimedAt: Date | null;
}

export interface PokemonConnectionService extends TokenProvider {
  /** The league's activity group, or null until the owner chooses one. */
  league(leagueId: string): UpstreamLeague | null;
  /** The connections `viewer` may see: the owner every one, a member every one not `outside`, anyone else only their own. */
  listConnections(leagueId: string, viewer: Actor): ProfessorConnection[];
  /** Every connection, oldest first, for finding the one a job recorded. */
  listActingConnections(): ActingConnection[];
  /** The full name for TDFs (ADR-0011 decision 8) of the connection with that player id; null when unset or none. */
  fullNameOf(professorPlayerId: string): string | null;
  /** Connections not `outside`, oldest first: reads across professors (ADR-0015 §3). */
  listReadableConnections(): ActingConnection[];
  /**
   * The connection `actor` may write to play-tools through for `professorPlayerId` (ADR-0015 §4): one they hold, or for
   * a `tournament` scope one lent to them for that tournament (`leaseId` then names the lease, §5).
   * @throws ConnectionAccessError `organizer_not_connected`, `needs_reconnect`, `not_your_connection`, `reverify_required`
   */
  actingConnection(actor: Actor, professorPlayerId: string, scope: ActingScope): { connectionId: number; leaseId: number | null };
  /**
   * The connection a request reads the league's play sessions as: the caller's lowest-id member connection that is
   * connected, else anyone's. @throws PokemonUpstreamError `not_connected` when there is none
   */
  readingConnection(leagueId: string, actor: Actor | null): number;
  /** Whether `actor` may see the league's pages, and why not (ADR-0015 §3). The owner always may. */
  access(actor: Actor): { member: boolean; waiting: WaitingReason };
  /** Begins a connect for `userId`: the attempt (PKCE verifier + state) lives 10 minutes, in memory only. */
  startConnect(userId: number): { authorizeUrl: string; expiresAt: Date };
  /**
   * Adds the Pokémon account the pasted login belongs to, reconnects it, or moves it from the owner to the professor
   * logging in (ADR-0015 §2); then reads its league membership. @throws ConnectError, PokemonUpstreamError
   */
  completeConnect(leagueId: string, actor: Actor, pastedUrl: string): Promise<{ connection: ProfessorConnection; outcome: 'added' | 'reconnected' | 'claimed' }>;
  /**
   * Sets a display name (ADR-0008: display only; the holder or the owner), a full name (ADR-0011 decision 8: the
   * holder only), or both. A name left out stays as it is; null clears it.
   * @throws ConnectionNotFoundError, ConnectionAccessError `not_your_connection`
   */
  renameProfessor(leagueId: string, actor: Actor, professorPlayerId: string, names: { name?: string | null; fullName?: string | null }): ProfessorConnection;
  /**
   * The leagues of the owner's own connections, each read as that connection. One that needs a reconnect is left out
   * and named; any other failure throws, so a league is never chosen from a partial set. @throws PokemonUpstreamError
   */
  listUpstreamLeagues(leagueId: string, owner: Actor): Promise<UpstreamLeagues>;
  /**
   * Chooses one of those leagues, then reads every connection's membership again, one at a time. `unchecked` counts
   * the reads that failed. @throws LeagueNotFoundError, PokemonUpstreamError
   */
  selectLeague(leagueId: string, owner: Actor, activityGroupId: string): Promise<{ league: UpstreamLeague; unchecked: number }>;
  /** Rotates each refresh token whose last refresh is ≥ 45 min old, then reads memberships ≥ 24 h old; one connection at a time. Never throws. */
  keepAliveAll(): Promise<KeepAliveReport[]>;
  /** Revokes at Hydra (best effort) and forgets the actor's own connection. @throws ConnectionNotFoundError, ConnectionAccessError */
  disconnect(leagueId: string, actor: Actor, professorPlayerId: string): Promise<{ revoked: boolean }>;
  /** Boot, before any refresh: re-seals tokens still sealed with the league id (v1) under their own row. Returns how many. */
  resealCarriedOver(leagueId: string): number;
  /** Boot: refreshes connected, unidentified connections so they learn their professor. Never throws. */
  identifyCarriedOver(): Promise<void>;
  /** How many connections the owner holds: their part of the seat budget (ADR-0015 §6). */
  ownerConnectionCount(): number;
  /** The connection `userId` holds, or null. */
  connectionOf(userId: number): HeldConnection | null;
  /** The player ID a message to `userId` goes to: their connection's, once known. */
  recipientOf(userId: number): string | null;
  /**
   * Removing a professor (ADR-0015 §8), step 1: reads their connections' refresh tokens while the rows exist. Call
   * `revoke` once the removal has committed; it revokes them at Pokémon, best effort, and never throws.
   */
  prepareRemoval(userId: number): { revoke(): Promise<void> };
  /** Step 2, inside the caller's transaction: deletes `userId`'s connections (their membership rows go with them). */
  deleteConnectionsOf(userId: number): void;
}

export interface PokemonConnectionDeps {
  db: Db;
  vault: StringVault;
  oauth: PtcOAuthClient;
  /** League discovery and identity through the play-tools adapter, authorised as the given connection. */
  gateway: (tokens: TokenProvider, connectionId: number) => Pick<PlayToolsGateway, 'listLeagues' | 'getProfessorProfile'>;
  /**
   * The accounts module: who holds a connection (a connection moves only from the owner to a professor, ADR-0015 §2),
   * the seat budget and the player ID an invite binds (§6), and the proof after a password reset (§8).
   */
  accounts: Pick<AccountsService, 'actor' | 'clearReverify'> & { seatsUsed(): number; boundPlayerId(userId: number): string | null };
  /**
   * Tournament leases (ADR-0015 §5): the store `actingConnection` checks and that disconnects, claims, removals and
   * membership reads end leases in; `ended` sends their notices once the ending has committed.
   */
  leases?: { store: LeaseStore; ended(rows: readonly EndedLease[]): void };
  now?: () => Date;
  log?: Pick<Logger, 'warn' | 'info'>;
}

/** The token vault's AAD for a connection's refresh token: a ciphertext only opens on its own row (ADR-0008). */
export const connectionAad = (id: number) => `pokemon_connection:${id}`;

const ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 20;
/** ADR-0015 §6: one account can't push out other users' attempts by starting connects over and over. */
const MAX_ATTEMPTS_PER_USER = 2;
/** ADR-0008, ADR-0015 §6: at most this many connections per install; the seat budget keeps the same number. */
export const MAX_CONNECTIONS = 10;
/** ADR-0003: a cached access token is used while it has at least this long left. */
const MIN_VALIDITY_MS = 2 * 60_000;
// Under the hourly schedule, so a slightly late run still refreshes.
const KEEPALIVE_AFTER_MS = 45 * 60_000;
/** ADR-0015 §3: the keep-alive reads a connection's membership again once its last read is this old. */
const MEMBERSHIP_STALE_MS = 24 * 60 * 60_000;

interface Attempt {
  userId: number;
  verifier: string;
  expiresAt: number;
}

type Row = typeof pokemonConnection.$inferSelect;
type Binding = typeof leagueUpstream.$inferSelect;
type Membership = typeof leagueMembership.$inferSelect;

/**
 * The pokemon-connection module (ADR-0003, ADR-0008, ADR-0015): one connection per professor, each with its own
 * encrypted refresh token and the user who holds it, and `TokenProvider`. Refreshes are serialised per connection,
 * and a rotated refresh token is written to the database before the new access token is handed to anyone: Hydra
 * revokes the whole chain when an old refresh token is replayed.
 */
export function createPokemonConnectionService(deps: PokemonConnectionDeps): PokemonConnectionService {
  const { db, vault, oauth } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;

  const attempts = new Map<string, Attempt>();
  /** Leases a removal ended, by user, until the removal's `revoke` hands their notices over after the commit. */
  const removalEndings = new Map<number, EndedLease[]>();

  /** Hands leases that ended to the lease service for their notices. Never throws: the ending has committed. */
  function notifyEnded(rows: readonly EndedLease[]) {
    if (rows.length === 0 || !deps.leases) return;
    try {
      deps.leases.ended(rows);
    } catch (err) {
      log.warn(`Lease end notices could not be sent (${(err as Error).message}).`, { err });
    }
  }
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
  const memberships = (): Map<number, Membership> => new Map(db.select().from(leagueMembership).all().map((m) => [m.connectionId, m]));

  function requireByPlayer(playerId: string): Row {
    const r = loadByPlayer(playerId);
    if (!r) throw new ConnectionNotFoundError(playerId);
    return r;
  }

  const labelOf = (r: Pick<Row, 'professorName' | 'professorPlayerId'>) => r.professorName ?? `Professor ${r.professorPlayerId}`;
  const notYours = (r: Row, what: string) =>
    new ConnectionAccessError('not_your_connection', `Only the user who connected ${labelOf(r)} can ${what}.`, r.professorPlayerId ?? '');

  function acting(r: Row, m: Membership | undefined): ActingConnection {
    const membership = m?.status ?? 'unknown';
    return {
      id: r.id,
      professorPlayerId: r.professorPlayerId,
      professorName: r.professorName,
      status: r.status,
      userId: r.userId,
      membership,
      canSubmit: membership === 'member' && (m?.canSubmit ?? false),
    };
  }

  function professorView(r: Row, viewer: Actor, m = memberships().get(r.id)): ProfessorConnection {
    return {
      ...acting(r, m),
      professorFullName: r.professorFullName,
      reason: r.statusReason,
      connectedAt: r.connectedAt,
      lastRefreshedAt: r.lastRefreshedAt,
      mine: r.userId === viewer.userId,
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

  /** A carried-over connection turned out to be a professor who is already connected: keep theirs, with the better membership. */
  async function mergeInto(kept: Row, dropped: Row): Promise<void> {
    const token = open(dropped);
    db.transaction((tx) => {
      const theirs = tx.select().from(leagueMembership).where(eq(leagueMembership.connectionId, dropped.id)).get();
      const ours = tx.select().from(leagueMembership).where(eq(leagueMembership.connectionId, kept.id)).get();
      if (theirs?.status === 'member' && ours?.status !== 'member') {
        tx.update(leagueMembership)
          .set({ status: 'member', canSubmit: theirs.canSubmit, checkedAt: theirs.checkedAt })
          .where(eq(leagueMembership.connectionId, kept.id))
          .run();
      }
      tx.delete(pokemonConnection).where(eq(pokemonConnection.id, dropped.id)).run();
    });
    accessTokens.delete(dropped.id);
    await revokeQuietly(token);
  }

  function bind(leagueId: string, league: League): void {
    const values = { activityGroupId: league.id, activityGroupName: league.name, activityGroupDisplayId: league.displayId };
    db.insert(leagueUpstream).values({ leagueId, ...values }).onConflictDoUpdate({ target: leagueUpstream.leagueId, set: values }).run();
  }

  const upstreamOf = (b: Binding): UpstreamLeague => ({ id: b.activityGroupId, name: b.activityGroupName, displayId: b.activityGroupDisplayId });

  /** Back to `unknown` and unchecked: the next keep-alive reads it again if the read that follows fails. */
  function resetMembership(leagueId: string, connectionId: number): void {
    const values = { leagueId, status: 'unknown' as const, canSubmit: false, checkedAt: null };
    db.insert(leagueMembership).values({ connectionId, ...values }).onConflictDoUpdate({ target: leagueMembership.connectionId, set: values }).run();
  }

  /**
   * Reads one connection's leagues as that connection and records whether the league's group is among them. A failed
   * read changes nothing. Returns whether it read.
   */
  async function checkMembership(leagueId: string, connectionId: number): Promise<boolean> {
    const b = bindingOf(leagueId);
    if (!b) return true;
    let leagues: League[];
    try {
      leagues = await deps.gateway(service, connectionId).listLeagues();
    } catch (err) {
      log.warn(`Could not read a Pokémon account's leagues; its league membership stays as it was (${(err as Error).message}).`, { err });
      return false;
    }
    const found = leagues.find((l) => l.id === b.activityGroupId);
    const endedLeases = db.transaction(() => {
      db.update(leagueMembership)
        .set({ leagueId, status: found ? 'member' : 'outside', canSubmit: found?.canSubmit ?? false, checkedAt: now() })
        .where(eq(leagueMembership.connectionId, connectionId))
        .run();
      // A professor whose account isn't in the league can't keep a lease (ADR-0015 §5). The owner is always a member.
      const holder = found ? null : load(connectionId);
      if (!holder || deps.accounts.actor(holder.userId)?.role !== 'professor') return [];
      return deps.leases?.store.endHeldBy(holder.userId, 'lessee_outside') ?? [];
    });
    notifyEnded(endedLeases);
    return true;
  }

  /** After the owner chooses a league: every connection reset, then read one at a time. Returns how many reads failed. */
  async function recheckAll(leagueId: string): Promise<number> {
    let unchecked = 0;
    for (const r of all()) {
      resetMembership(leagueId, r.id);
      // A connection that needs a reconnect can't be read; it stays unknown until it reconnects.
      if (r.status !== 'connected' || !(await checkMembership(leagueId, r.id))) unchecked += 1;
    }
    return unchecked;
  }

  /**
   * Writes a completed connect (ADR-0015 §2): reconnects the actor's own row, moves the owner's row to a professor,
   * claims a carried-over row of the actor's, or adds a row under the cap. Any other connect for a held account is
   * refused. Runs in one transaction, so two connects for one account settle with one row.
   */
  function persistConnect(
    actor: Actor,
    grant: TokenGrant & { refreshToken: string },
    profile: ProfessorProfile,
  ): { id: number; outcome: 'added' | 'reconnected' | 'claimed'; claimedFrom?: Actor; endedLeases?: EndedLease[] } {
    return db.transaction((tx) => {
      const at = now();
      const fields = { ptcUserId: grant.subject, status: 'connected' as const, statusReason: null, connectedAt: at, lastRefreshedAt: at };
      const seal = (id: number) => vault.encrypt(grant.refreshToken, connectionAad(id));

      const rowsNow = tx.select().from(pokemonConnection).orderBy(asc(pokemonConnection.id)).all();
      const own = rowsNow.find((r) => r.professorPlayerId === profile.playerId);
      const bound = actor.role === 'professor' ? deps.accounts.boundPlayerId(actor.userId) : null;
      if (bound !== null && bound !== profile.playerId) {
        throw new ConnectError(
          'invite_player_mismatch',
          `Your invite is for Pokémon account ${bound}, so only that account can be connected here. Log in to Pokémon as that account.`,
        );
      }
      if (actor.role === 'professor') {
        const held = rowsNow.find((r) => r.userId === actor.userId);
        if (held && held.professorPlayerId !== profile.playerId) {
          throw new ConnectError(
            'one_connection_only',
            `You already connected ${labelOf(held)}. Disconnect it first, or log in to Pokémon as that account to reconnect it.`,
          );
        }
      }

      if (own && own.userId !== actor.userId) {
        const holder = deps.accounts.actor(own.userId);
        if (holder?.role !== 'owner' || actor.role !== 'professor') {
          throw new ConnectError(
            'connection_held',
            `Someone else in this app has already connected Pokémon account ${profile.playerId}. They can disconnect it first.`,
          );
        }
        tx.update(pokemonConnection)
          .set({ ...fields, userId: actor.userId, claimedFromUserId: own.userId, claimedAt: at, refreshTokenCiphertext: seal(own.id) })
          .where(eq(pokemonConnection.id, own.id))
          .run();
        // The owner no longer holds it, so every lease they granted on it ends (ADR-0015 §2, §5).
        const endedLeases = deps.leases?.store.endOnConnection(own.id, 'connection_gone') ?? [];
        return { id: own.id, outcome: 'claimed' as const, claimedFrom: holder, endedLeases };
      }

      const carried = own
        ? undefined
        : rowsNow.find((r) => r.professorPlayerId === null && r.userId === actor.userId && (r.status === 'needs_reconnect' || r.ptcUserId === grant.subject));
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
      // A professor's own seat already covers their connection; an owner's new one takes a seat (ADR-0015 §6).
      if (actor.role === 'owner' && deps.accounts.seatsUsed() >= MAX_CONNECTIONS) {
        throw new ConnectError(
          'connection_limit',
          `All ${MAX_CONNECTIONS} places are taken by your Pokémon accounts, professors and open invites. Revoke an invite or remove a professor first.`,
        );
      }
      const { id } = tx
        .insert(pokemonConnection)
        .values({ ...fields, userId: actor.userId, professorPlayerId: profile.playerId, refreshTokenCiphertext: Buffer.alloc(0) })
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

  /** The leagues of `userId`'s connections, deduplicated, each read as that connection. */
  async function leaguesOf(userId: number): Promise<{ leagues: League[]; excluded: UpstreamLeagues['excluded'] }> {
    const leagues: League[] = [];
    const excluded: UpstreamLeagues['excluded'] = [];
    for (const r of all().filter((x) => x.userId === userId)) {
      const leaveOut = () => excluded.push({ playerId: r.professorPlayerId, name: r.professorName });
      if (r.status === 'needs_reconnect') {
        leaveOut();
        continue;
      }
      let theirs: League[];
      try {
        theirs = await deps.gateway(service, r.id).listLeagues();
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError && err.code === 'needs_reconnect')) throw err;
        leaveOut();
        continue;
      }
      for (const l of theirs) if (!leagues.some((x) => x.id === l.id)) leagues.push(l);
    }
    return { leagues, excluded };
  }

  /** After an owner's connect: a league with none chosen takes the one league their connections are in, if there is one. */
  async function autoSelectLeague(leagueId: string, owner: Actor): Promise<boolean> {
    if (bindingOf(leagueId)) return false;
    try {
      const { leagues } = await leaguesOf(owner.userId);
      if (leagues.length !== 1) return false;
      bind(leagueId, leagues[0]!);
      return true;
    } catch (err) {
      log.warn(`League discovery after connecting failed; pick the league in Settings (${(err as Error).message}).`, { err });
      return false;
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

  /** The keep-alive's membership read: a connected connection whose last read is a day old, or that was never read. */
  async function recheckIfStale(leagueId: string, id: number): Promise<void> {
    const r = load(id);
    if (!r || r.status !== 'connected') return;
    const m = memberships().get(id);
    if (!m) resetMembership(leagueId, id);
    else if (m.checkedAt && now().getTime() - m.checkedAt.getTime() < MEMBERSHIP_STALE_MS) return;
    await checkMembership(leagueId, id);
  }

  const visibleTo = (viewer: Actor, r: Row, m: Membership | undefined) => {
    if (viewer.role === 'owner' || r.userId === viewer.userId) return true;
    return service.access(viewer).member && m?.status !== 'outside';
  };

  const service: PokemonConnectionService = {
    league(leagueId) {
      const b = bindingOf(leagueId);
      return b ? upstreamOf(b) : null;
    },

    listConnections(_leagueId, viewer) {
      const ms = memberships();
      // Named professors first, by name; then the rest by player id.
      const named = (r: Row) => (r.professorName === null ? 1 : 0);
      return all()
        .filter((r) => visibleTo(viewer, r, ms.get(r.id)))
        .sort(
          (x, y) =>
            named(x) - named(y) ||
            (x.professorName ?? '').localeCompare(y.professorName ?? '') ||
            (x.professorPlayerId ?? '').localeCompare(y.professorPlayerId ?? ''),
        )
        .map((r) => professorView(r, viewer, ms.get(r.id)));
    },

    listActingConnections() {
      const ms = memberships();
      return all().map((r) => acting(r, ms.get(r.id)));
    },

    fullNameOf: (professorPlayerId) => loadByPlayer(professorPlayerId)?.professorFullName ?? null,

    listReadableConnections() {
      return service.listActingConnections().filter((c) => c.membership !== 'outside');
    },

    actingConnection(actor, professorPlayerId, scope) {
      const r = loadByPlayer(professorPlayerId);
      if (!r) {
        throw new ConnectionAccessError(
          'organizer_not_connected',
          `Professor ${professorPlayerId} isn't connected. Their Pokémon account must be connected in Settings to act as them.`,
          professorPlayerId,
        );
      }
      // A lease counts only for one tournament's staff or results, and never for an `own` scope (ADR-0015 §4, §5).
      const leaseId =
        r.userId === actor.userId || scope.kind !== 'tournament' ? null : (deps.leases?.store.liveFor(actor.userId, r.id, scope.tournamentId) ?? null);
      if (r.userId !== actor.userId && leaseId === null) throw notYours(r, 'act as them in play-tools');
      if (leaseId !== null && !actor.reverifyRequired && !service.access(actor).member) throw notYours(r, 'act as them in play-tools');
      if (actor.reverifyRequired) {
        throw new ConnectionAccessError(
          'reverify_required',
          `Log in to Pokémon as ${labelOf(r)} in Settings to confirm it's you after your password reset.`,
          professorPlayerId,
        );
      }
      if (r.status === 'needs_reconnect') {
        throw new ConnectionAccessError('needs_reconnect', `Reconnect ${labelOf(r)} in Settings.`, professorPlayerId);
      }
      return { connectionId: r.id, leaseId };
    },

    readingConnection(_leagueId, actor) {
      const usable = service.listActingConnections().filter((c) => c.membership === 'member' && c.status === 'connected');
      const pick = (actor && usable.find((c) => c.userId === actor.userId)) ?? usable[0];
      if (!pick) throw new PokemonUpstreamError('not_connected', 'No Pokémon account confirmed in the league is connected. Connect one in Settings.');
      return pick.id;
    },

    access(actor) {
      if (actor.role === 'owner') return { member: true, waiting: null };
      if (actor.reverifyRequired) return { member: false, waiting: 'reverify_required' };
      const held = all().find((r) => r.userId === actor.userId);
      if (!held) return { member: false, waiting: 'no_connection' };
      const status = memberships().get(held.id)?.status ?? 'unknown';
      return status === 'member' ? { member: true, waiting: null } : { member: false, waiting: status };
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
      const theirs = [...attempts].filter(([, a]) => a.userId === userId);
      while (theirs.length >= MAX_ATTEMPTS_PER_USER) attempts.delete(theirs.shift()![0]);
      while (attempts.size >= MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value!);

      const { verifier, challenge } = createPkcePair();
      const state = createState();
      const expiresAt = at + ATTEMPT_TTL_MS;
      attempts.set(state, { userId, verifier, expiresAt });
      return { authorizeUrl: oauth.authorizeUrl(challenge, state), expiresAt: new Date(expiresAt) };
    },

    async completeConnect(leagueId, actor, pastedUrl) {
      const parsed = parseCallbackUrl(pastedUrl);
      if (!parsed.ok) throw new ConnectError('invalid_url', parsed.error);

      const attempt = attempts.get(parsed.state);
      if (!attempt || attempt.userId !== actor.userId) {
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
          const done = persistConnect(actor, { ...grant, refreshToken }, profile);
          accessTokens.set(done.id, token);
          return done;
        } catch (err) {
          if (err instanceof ConnectError) void revokeQuietly(refreshToken);
          throw err;
        }
      };
      const own = loadByPlayer(profile.playerId);
      const { id, outcome, claimedFrom, endedLeases } = own ? await withLock(own.id, async () => write()) : write();
      notifyEnded(endedLeases ?? []);
      if (claimedFrom) {
        log.info(`Pokémon connection for professor ${profile.playerId} moved from ${claimedFrom.username} to ${actor.username}`, {
          professorPlayerId: profile.playerId,
          fromUser: claimedFrom.username,
          toUser: actor.username,
        });
      }

      if (actor.reverifyRequired) deps.accounts.clearReverify(actor.userId);

      const chosen = actor.role === 'owner' && (await autoSelectLeague(leagueId, actor));
      if (chosen) await recheckAll(leagueId);
      else {
        resetMembership(leagueId, id);
        await checkMembership(leagueId, id);
      }
      return { connection: professorView(load(id)!, actor), outcome };
    },

    renameProfessor(_leagueId, actor, professorPlayerId, { name, fullName }) {
      const r = requireByPlayer(professorPlayerId);
      const holder = r.userId === actor.userId;
      if (name !== undefined && !holder && actor.role !== 'owner') throw notYours(r, 'rename it');
      if (fullName !== undefined && !holder) throw notYours(r, 'change its full name');
      // Drizzle leaves an undefined field out of the update, so a name that wasn't sent stays as it is.
      if (name !== undefined || fullName !== undefined) {
        db.update(pokemonConnection)
          .set({ professorName: name, professorFullName: fullName })
          .where(eq(pokemonConnection.id, r.id))
          .run();
      }
      return professorView(load(r.id)!, actor);
    },

    async listUpstreamLeagues(leagueId, owner) {
      const { leagues, excluded } = await leaguesOf(owner.userId);
      return { leagues, selectedId: bindingOf(leagueId)?.activityGroupId ?? null, excluded };
    },

    async selectLeague(leagueId, owner, activityGroupId) {
      const { leagues } = await leaguesOf(owner.userId);
      const chosen = leagues.find((l) => l.id === activityGroupId);
      if (!chosen) throw new LeagueNotFoundError(activityGroupId);
      bind(leagueId, chosen);
      const unchecked = await recheckAll(leagueId);
      return { league: upstreamOf(bindingOf(leagueId)!), unchecked };
    },

    async keepAliveAll() {
      const reports: KeepAliveReport[] = [];
      for (const r of all()) {
        reports.push({ connectionId: r.id, professorPlayerId: r.professorPlayerId, ...(await keepAlive(r.id)) });
        for (const b of db.select().from(leagueUpstream).all()) await recheckIfStale(b.leagueId, r.id);
      }
      return reports;
    },

    async disconnect(_leagueId, actor, professorPlayerId) {
      const r = requireByPlayer(professorPlayerId);
      if (r.userId !== actor.userId) throw notYours(r, 'disconnect it');
      return withLock(r.id, async () => {
        accessTokens.delete(r.id);
        let revoked = false;
        try {
          revoked = await revokeQuietly(vault.decrypt(r.refreshTokenCiphertext, connectionAad(r.id)));
        } catch (err) {
          if (!(err instanceof VaultError)) throw err;
        }
        // Its leases end, then go with it (ADR-0015 §5); their notices go out once the delete has committed.
        const endedLeases = db.transaction(() => {
          const e = deps.leases?.store.endOnConnection(r.id, 'connection_gone') ?? [];
          db.delete(pokemonConnection).where(eq(pokemonConnection.id, r.id)).run();
          return e;
        });
        notifyEnded(endedLeases);
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

    ownerConnectionCount() {
      return all().filter((r) => deps.accounts.actor(r.userId)?.role === 'owner').length;
    },

    connectionOf(userId) {
      const r = all().find((x) => x.userId === userId);
      if (!r) return null;
      return {
        playerId: r.professorPlayerId,
        name: r.professorName,
        status: r.status,
        membership: memberships().get(r.id)?.status ?? 'unknown',
        claimedAt: r.claimedAt,
      };
    },

    recipientOf(userId) {
      return all().find((r) => r.userId === userId)?.professorPlayerId ?? null;
    },

    prepareRemoval(userId) {
      const tokens: string[] = [];
      for (const r of all().filter((x) => x.userId === userId)) {
        try {
          tokens.push(vault.decrypt(r.refreshTokenCiphertext, connectionAad(r.id)));
        } catch (err) {
          if (!(err instanceof VaultError)) throw err;
        }
      }
      return {
        async revoke() {
          // The leases `deleteConnectionsOf` ended inside the removal: their notices go out only after it committed.
          const endedLeases = removalEndings.get(userId) ?? [];
          removalEndings.delete(userId);
          notifyEnded(endedLeases);
          for (const t of tokens) await revokeQuietly(t);
        },
      };
    },

    deleteConnectionsOf(userId) {
      const endedLeases: EndedLease[] = [];
      for (const r of all().filter((x) => x.userId === userId)) {
        accessTokens.delete(r.id);
        endedLeases.push(...(deps.leases?.store.endOnConnection(r.id, 'connection_gone') ?? []));
        db.delete(pokemonConnection).where(eq(pokemonConnection.id, r.id)).run();
      }
      endedLeases.push(...(deps.leases?.store.endHeldBy(userId, 'lessee_removed') ?? []));
      removalEndings.set(userId, endedLeases);
    },
  };

  return service;
}
