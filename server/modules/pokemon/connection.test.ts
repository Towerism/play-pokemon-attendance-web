import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { s256Challenge } from './adapters/ptc-oauth/pkce';
import { ConnectError, LeagueNotFoundError, type PokemonConnectionService, createPokemonConnectionService } from './connection';
import { PokemonUpstreamError } from './ports/errors';
import type { League } from './ports/play-tools-gateway';
import type { PtcOAuthClient, TokenGrant } from './ports/ptc-oauth';
import type { TokenProvider } from './ports/token-provider';
import { type TokenVault, createTokenVault } from './vault/vault';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const SUB = '0123456789abcdef0123456789abcdef';
const MIN = 60_000;
const HOUR = 60 * MIN;
const USER = 1;

const STORE: League = { id: 'group-1', name: 'Card Shop', displayId: 'L5012', canSubmit: true };
const OTHER_STORE: League = { id: 'group-2', name: 'Game Den', displayId: 'L7000', canSubmit: false };

let database: OpenDatabase;
let vault: TokenVault;
let clock: Date;
let oauth: FakeOAuth;
let leagues: League[] | Error;
let service: PokemonConnectionService;
let log: { warn: ReturnType<typeof vi.fn> };

/** Hydra as a fake: rotates the refresh token on every refresh and tracks which tokens are alive. */
class FakeOAuth implements PtcOAuthClient {
  refreshCalls: string[] = [];
  exchanges: { code: string; verifier: string }[] = [];
  revoked: string[] = [];
  accessTtlMs = HOUR;
  subject = SUB;
  nextError: Error | undefined;
  revokeError: Error | undefined;
  omitRefreshToken = false;
  /** Holds refreshes until released, to exercise concurrency. */
  gate: Promise<void> | undefined;
  private serial = 0;

  authorizeUrl(challenge: string, state: string) {
    return `https://access.pokemon.com/oauth2/auth?code_challenge=${challenge}&state=${state}`;
  }

  async exchangeCode(code: string, verifier: string) {
    this.exchanges.push({ code, verifier });
    return this.issue();
  }

  async refresh(refreshToken: string) {
    this.refreshCalls.push(refreshToken);
    await this.gate;
    return this.issue();
  }

  async revoke(refreshToken: string) {
    if (this.revokeError) throw this.revokeError;
    this.revoked.push(refreshToken);
  }

  private issue(): TokenGrant {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = undefined;
      throw err;
    }
    this.serial += 1;
    return {
      accessToken: `access-${this.serial}`,
      expiresAt: new Date(clock.getTime() + this.accessTtlMs),
      subject: this.subject,
      refreshToken: this.omitRefreshToken ? null : `ory_rt_${this.serial}`,
    };
  }
}

function build(): PokemonConnectionService {
  return createPokemonConnectionService({
    db: database.db,
    vault,
    oauth,
    gateway: (tokens: TokenProvider, leagueId: string) => ({
      async listLeagues() {
        await tokens.getAccessToken(leagueId);
        if (leagues instanceof Error) throw leagues;
        return leagues;
      },
    }),
    now: () => clock,
    log,
  });
}

const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
const row = () =>
  database.sqlite.prepare('select * from pokemon_connection where league_id = ?').get(L) as
    | { refresh_token_ciphertext: Buffer; status: string; status_reason: string | null; ptc_user_id: string; activity_group_id: string | null; last_refreshed_at: number }
    | undefined;
const storedRefreshToken = () => vault.decrypt(row()!.refresh_token_ciphertext, L);

/** Runs the whole connect flow the way the Settings page does. */
async function connect(svc = service, userId = USER) {
  const { authorizeUrl } = svc.startConnect(L, userId);
  const state = new URL(authorizeUrl).searchParams.get('state');
  return svc.completeConnect(L, userId, `https://play-tools.pokemon.com/loggedIn?code=code-${state}&state=${state}&scope=openid`);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  vault = createTokenVault(randomBytes(32).toString('base64'));
  clock = new Date('2026-10-14T22:00:00Z');
  oauth = new FakeOAuth();
  leagues = [STORE];
  log = { warn: vi.fn() };
  service = build();
});
afterEach(() => database.close());

describe('getStatus', () => {
  it('is not_connected before anyone connects', () => {
    expect(service.getStatus(L)).toEqual({ status: 'not_connected', reason: null, connectedAt: null, lastRefreshedAt: null, league: null });
  });
});

describe('connect flow (§4.1, paste-back)', () => {
  it("starts with an authorize URL carrying an S256 challenge and state, and stores nothing", () => {
    const url = new URL(service.startConnect(L, USER).authorizeUrl);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{16,}$/);
    expect(row()).toBeUndefined();
  });

  it('redeems the pasted code with the verifier behind the challenge, and stores the refresh token encrypted', async () => {
    const { authorizeUrl } = service.startConnect(L, USER);
    const params = new URL(authorizeUrl).searchParams;

    const status = await service.completeConnect(
      L,
      USER,
      `https://play-tools.pokemon.com/loggedIn?code=abc&state=${params.get('state')}`,
    );

    expect(oauth.exchanges).toHaveLength(1);
    expect(oauth.exchanges[0]!.code).toBe('abc');
    expect(s256Challenge(oauth.exchanges[0]!.verifier)).toBe(params.get('code_challenge'));
    expect(status).toEqual({
      status: 'connected',
      reason: null,
      connectedAt: clock,
      lastRefreshedAt: clock,
      league: { id: 'group-1', name: 'Card Shop', displayId: 'L5012', canSubmit: true },
    });
    expect(row()!.ptc_user_id).toBe(SUB);
    expect(row()!.refresh_token_ciphertext.toString('latin1')).not.toContain('ory_rt_1');
    expect(storedRefreshToken()).toBe('ory_rt_1');
  });

  it('never exposes a token in the status it returns', async () => {
    const status = await connect();
    expect(JSON.stringify(status)).not.toMatch(/ory_rt|access-/);
  });

  it('leaves the league unchosen when the organizer has several', async () => {
    leagues = [STORE, OTHER_STORE];
    expect((await connect()).league).toBeNull();
  });

  it('still connects when league discovery fails; the league can be picked later', async () => {
    leagues = new PokemonUpstreamError('unavailable', 'down');
    const status = await connect();
    expect(status.status).toBe('connected');
    expect(status.league).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'League discovery after connecting failed; pick the league in Settings (down).',
      { err: expect.any(PokemonUpstreamError) },
    );
  });

  it.each([
    ['not a URL', 'hello'],
    ['another site', 'https://evil.example/loggedIn?code=a&state=b'],
    ['a login error', 'https://play-tools.pokemon.com/loggedIn?error=access_denied'],
  ])('refuses %s with invalid_url', async (_label, pasted) => {
    service.startConnect(L, USER);
    const err = await rejection(service.completeConnect(L, USER, pasted));
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe('invalid_url');
    expect(oauth.exchanges).toEqual([]);
  });

  it('refuses a state it never issued', async () => {
    service.startConnect(L, USER);
    const err = await rejection(service.completeConnect(L, USER, 'https://play-tools.pokemon.com/loggedIn?code=a&state=forged'));
    expect((err as ConnectError).code).toBe('unknown_attempt');
    expect(oauth.exchanges).toEqual([]);
  });

  it("refuses a state started by another app user (bound to the starter's session)", async () => {
    const { authorizeUrl } = service.startConnect(L, USER);
    const state = new URL(authorizeUrl).searchParams.get('state');
    const err = await rejection(service.completeConnect(L, 2, `https://play-tools.pokemon.com/loggedIn?code=a&state=${state}`));
    expect((err as ConnectError).code).toBe('unknown_attempt');
    expect(oauth.exchanges).toEqual([]);
  });

  it('uses each attempt once, even when the exchange failed', async () => {
    const { authorizeUrl } = service.startConnect(L, USER);
    const pasted = `https://play-tools.pokemon.com/loggedIn?code=a&state=${new URL(authorizeUrl).searchParams.get('state')}`;
    oauth.nextError = new PokemonUpstreamError('unavailable', 'down');
    await rejection(service.completeConnect(L, USER, pasted));

    const err = await rejection(service.completeConnect(L, USER, pasted));
    expect((err as ConnectError).code).toBe('unknown_attempt');
    expect(oauth.exchanges).toHaveLength(1);
  });

  it('expires an attempt after 10 minutes', async () => {
    const { authorizeUrl } = service.startConnect(L, USER);
    const state = new URL(authorizeUrl).searchParams.get('state');
    advance(10 * MIN + 1);
    const err = await rejection(service.completeConnect(L, USER, `https://play-tools.pokemon.com/loggedIn?code=a&state=${state}`));
    expect((err as ConnectError).code).toBe('expired');
    expect(oauth.exchanges).toEqual([]);
  });

  it('accepts an attempt at exactly 10 minutes', async () => {
    const { authorizeUrl } = service.startConnect(L, USER);
    const state = new URL(authorizeUrl).searchParams.get('state');
    advance(10 * MIN);
    await expect(service.completeConnect(L, USER, `https://play-tools.pokemon.com/loggedIn?code=a&state=${state}`)).resolves.toMatchObject({
      status: 'connected',
    });
  });

  it('reports a code Pokémon refuses (already used, too old) as code_rejected and stores nothing', async () => {
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'already used');
    const err = await rejection(connect());
    expect((err as ConnectError).code).toBe('code_rejected');
    expect(row()).toBeUndefined();
  });

  it('fails without storing anything when Hydra grants no refresh token (offline scope missing)', async () => {
    oauth.omitRefreshToken = true;
    const err = await rejection(connect());
    expect((err as PokemonUpstreamError).code).toBe('unexpected_shape');
    expect(row()).toBeUndefined();
  });

  it('reconnecting the same account clears needs_reconnect and keeps the chosen league', async () => {
    await connect();
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'revoked');
    advance(HOUR);
    await rejection(service.getAccessToken(L));
    expect(service.getStatus(L).status).toBe('needs_reconnect');

    leagues = [STORE, OTHER_STORE]; // would leave a fresh connection unchosen
    const status = await connect();

    expect(status).toMatchObject({ status: 'connected', reason: null, league: { id: 'group-1' } });
    expect(storedRefreshToken()).toBe('ory_rt_2');
  });

  it('connecting a different Pokémon account forgets the league chosen for the old one', async () => {
    await connect();
    oauth.subject = 'ffffffffffffffffffffffffffffffff';
    leagues = [STORE, OTHER_STORE];
    const status = await connect();
    expect(status.league).toBeNull();
    expect(row()!.ptc_user_id).toBe('ffffffffffffffffffffffffffffffff');
  });
});

describe('getAccessToken (TokenProvider contract, ADR-0003)', () => {
  it('throws not_connected before a connection exists', async () => {
    const err = await rejection(service.getAccessToken(L));
    expect((err as PokemonUpstreamError).code).toBe('not_connected');
  });

  it('serves the token from the connect while it has ≥ 2 minutes left, without refreshing', async () => {
    await connect();
    advance(HOUR - 2 * MIN);
    expect(await service.getAccessToken(L)).toEqual({ value: 'access-1', expiresAt: new Date('2026-10-14T23:00:00Z'), subject: SUB });
    expect(oauth.refreshCalls).toEqual([]);
  });

  it('refreshes once under 2 minutes are left, persisting the rotated refresh token before handing out the access token', async () => {
    await connect();
    advance(HOUR - 2 * MIN + 1);

    const token = await service.getAccessToken(L);

    expect(oauth.refreshCalls).toEqual(['ory_rt_1']);
    expect(token.value).toBe('access-2');
    expect(storedRefreshToken()).toBe('ory_rt_2');
    expect(row()!.last_refreshed_at).toBe(Math.floor(clock.getTime() / 1000));
  });

  it('uses the rotated refresh token for the next refresh (never replays an old one)', async () => {
    await connect();
    advance(HOUR);
    await service.getAccessToken(L);
    advance(HOUR);
    await service.getAccessToken(L);
    expect(oauth.refreshCalls).toEqual(['ory_rt_1', 'ory_rt_2']);
  });

  it('keeps the current refresh token when Hydra does not rotate it', async () => {
    await connect();
    oauth.omitRefreshToken = true;
    advance(HOUR);
    await service.getAccessToken(L);
    expect(storedRefreshToken()).toBe('ory_rt_1');
  });

  it('serialises concurrent refreshes: one upstream call, everyone gets the same token', async () => {
    await connect();
    advance(HOUR);
    let release!: () => void;
    oauth.gate = new Promise((r) => (release = r));

    const calls = Promise.all([service.getAccessToken(L), service.getAccessToken(L), service.getAccessToken(L)]);
    release();
    const tokens = await calls;

    expect(oauth.refreshCalls).toEqual(['ory_rt_1']);
    expect(new Set(tokens.map((t) => t.value))).toEqual(new Set(['access-2']));
  });

  it('hands out no token when the rotated refresh token cannot be saved', async () => {
    await connect();
    advance(HOUR);
    database.sqlite.exec(
      "create trigger no_writes before update on pokemon_connection begin select raise(abort, 'disk I/O error'); end",
    );

    await expect(service.getAccessToken(L)).rejects.toThrow(/disk I\/O error/);
    database.sqlite.exec('drop trigger no_writes');
    expect(storedRefreshToken()).toBe('ory_rt_1');

    // Nothing was cached either: the next caller goes back to Hydra.
    await service.getAccessToken(L);
    expect(oauth.refreshCalls).toHaveLength(2);
  });

  it('marks the connection needs_reconnect on invalid_grant and stops calling Hydra', async () => {
    await connect();
    advance(HOUR);
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'Pokémon no longer accepts this login');

    const err = await rejection(service.getAccessToken(L));
    expect((err as PokemonUpstreamError).code).toBe('needs_reconnect');
    expect(service.getStatus(L)).toMatchObject({ status: 'needs_reconnect', reason: expect.stringMatching(/no longer accepts/) });

    const again = await rejection(service.getAccessToken(L));
    expect((again as PokemonUpstreamError).code).toBe('needs_reconnect');
    expect(oauth.refreshCalls).toHaveLength(1);
  });

  it('marks needs_reconnect when the stored token no longer decrypts (vault key replaced)', async () => {
    await connect();
    vault = createTokenVault(randomBytes(32).toString('base64'));
    const restarted = build();

    const err = await rejection(restarted.getAccessToken(L));
    expect((err as PokemonUpstreamError).code).toBe('needs_reconnect');
    expect(restarted.getStatus(L)).toMatchObject({ status: 'needs_reconnect', reason: expect.stringMatching(/key/) });
    expect(oauth.refreshCalls).toEqual([]);
  });

  it('passes a transient failure through, stays connected, and tries again next call', async () => {
    await connect();
    advance(HOUR);
    oauth.nextError = new PokemonUpstreamError('unavailable', 'down');

    expect(((await rejection(service.getAccessToken(L))) as PokemonUpstreamError).code).toBe('unavailable');
    expect(service.getStatus(L).status).toBe('connected');
    expect((await service.getAccessToken(L)).value).toBe('access-2');
  });

  it('refreshes from the stored token after a restart (no cached access token)', async () => {
    await connect();
    const restarted = build();
    expect((await restarted.getAccessToken(L)).value).toBe('access-2');
    expect(oauth.refreshCalls).toEqual(['ory_rt_1']);
  });
});

describe('keepAlive (hourly task)', () => {
  it('refreshes when the last refresh is ≥ 45 min old, even while the access token is still valid', async () => {
    oauth.accessTtlMs = 24 * HOUR;
    await connect();
    advance(45 * MIN);

    expect(await service.keepAlive(L)).toEqual({ outcome: 'refreshed' });
    expect(storedRefreshToken()).toBe('ory_rt_2');
  });

  it('skips a connection refreshed in the last 45 min', async () => {
    await connect();
    advance(45 * MIN - 1);
    expect(await service.keepAlive(L)).toEqual({ outcome: 'skipped_recent' });
    expect(oauth.refreshCalls).toEqual([]);
  });

  it('does nothing without a connection', async () => {
    expect(await service.keepAlive(L)).toEqual({ outcome: 'not_connected' });
  });

  it('does not call Hydra for a connection that already needs a reconnect', async () => {
    await connect();
    advance(HOUR);
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'revoked');
    await rejection(service.getAccessToken(L));
    advance(HOUR);

    expect(await service.keepAlive(L)).toEqual({ outcome: 'needs_reconnect' });
    expect(oauth.refreshCalls).toHaveLength(1);
  });

  it('reports needs_reconnect when the refresh is refused', async () => {
    await connect();
    advance(HOUR);
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'revoked');
    expect(await service.keepAlive(L)).toEqual({ outcome: 'needs_reconnect' });
    expect(service.getStatus(L).status).toBe('needs_reconnect');
  });

  it('reports a transient failure without throwing', async () => {
    await connect();
    advance(HOUR);
    oauth.nextError = new PokemonUpstreamError('unavailable', 'Pokémon answered 503');
    expect(await service.keepAlive(L)).toEqual({ outcome: 'failed', message: 'Pokémon answered 503' });
  });
});

describe('league discovery', () => {
  it("lists the organizer's leagues and which one is chosen", async () => {
    await connect();
    leagues = [STORE, OTHER_STORE];
    expect(await service.listUpstreamLeagues(L)).toEqual({ leagues: [STORE, OTHER_STORE], selectedId: 'group-1' });
  });

  it('binds the chosen league', async () => {
    leagues = [STORE, OTHER_STORE];
    await connect();

    const status = await service.selectLeague(L, 'group-2');

    expect(status.league).toEqual({ id: 'group-2', name: 'Game Den', displayId: 'L7000', canSubmit: false });
    expect(service.getStatus(L).league?.id).toBe('group-2');
  });

  it("refuses a league the organizer doesn't have and keeps the current one", async () => {
    await connect();
    await expect(service.selectLeague(L, 'someone-elses')).rejects.toBeInstanceOf(LeagueNotFoundError);
    expect(service.getStatus(L).league?.id).toBe('group-1');
  });

  it('needs a connection', async () => {
    const err = await rejection(service.listUpstreamLeagues(L));
    expect((err as PokemonUpstreamError).code).toBe('not_connected');
  });
});

describe('disconnect', () => {
  it('revokes the refresh token at Hydra, forgets it, and drops the cached access token', async () => {
    await connect();

    expect(await service.disconnect(L)).toEqual({ revoked: true });

    expect(oauth.revoked).toEqual(['ory_rt_1']);
    expect(row()).toBeUndefined();
    expect(service.getStatus(L).status).toBe('not_connected');
    expect(((await rejection(service.getAccessToken(L))) as PokemonUpstreamError).code).toBe('not_connected');
  });

  it('still forgets the token locally when Hydra cannot be reached', async () => {
    await connect();
    oauth.revokeError = new PokemonUpstreamError('unavailable', 'down');
    expect(await service.disconnect(L)).toEqual({ revoked: false });
    expect(row()).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      'Could not revoke the refresh token at Pokémon; forgetting it locally anyway (down).',
      { err: expect.any(PokemonUpstreamError) },
    );
  });

  it('is a no-op without a connection', async () => {
    expect(await service.disconnect(L)).toEqual({ revoked: false });
    expect(oauth.revoked).toEqual([]);
  });
});
