import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { s256Challenge } from './adapters/ptc-oauth/pkce';
import type { Actor } from '../accounts/service';
import {
  ConnectError,
  ConnectionAccessError,
  ConnectionNotFoundError,
  LeagueNotFoundError,
  type PokemonConnectionService,
  connectionAad,
  createPokemonConnectionService,
} from './connection';
import { PokemonUpstreamError } from './ports/errors';
import type { League } from './ports/play-tools-gateway';
import type { PtcOAuthClient, TokenGrant } from './ports/ptc-oauth';
import type { TokenProvider } from './ports/token-provider';
import type { StringVault } from '@towerism/selfhost-kit';
import { tokenVault } from '../../bootstrap/vaults';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const MIN = 60_000;
const HOUR = 60 * MIN;
const OWNER: Actor = { userId: 1, username: 'organizer', role: 'owner' };
const MISTY: Actor = { userId: 2, username: 'misty', role: 'professor' };
const GARY: Actor = { userId: 3, username: 'gary', role: 'professor' };
const ACTORS = new Map([OWNER, MISTY, GARY].map((a) => [a.userId, a]));
const USER = OWNER.userId;

const STORE: League = { id: 'group-1', name: 'Card Shop', displayId: 'L5012', canSubmit: true };
const OTHER_STORE: League = { id: 'group-2', name: 'Game Den', displayId: 'L7000', canSubmit: true };

interface Professor {
  sub: string;
  playerId: string;
  name: string | null;
  leagues: League[] | Error;
}

const ASH: Professor = { sub: 'sub-ash', playerId: '0012345', name: 'Ash Ketchum', leagues: [STORE] };
const BROCK: Professor = { sub: 'sub-brock', playerId: '222', name: 'Brock Harrison', leagues: [OTHER_STORE] };

let database: OpenDatabase;
let vault: StringVault;
let clock: Date;
let oauth: FakeOAuth;
let professors: Map<string, Professor>;
let profileError: Error | undefined;
let profileCalls: string[];
let leagueCalls: string[];
let leaguesInFlight: number;
let mostLeaguesInFlight: number;
let service: PokemonConnectionService;
let log: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };

/** Hydra as a fake: one rotating chain per account (by `sub`), tracking which refresh token belongs to whom. */
class FakeOAuth implements PtcOAuthClient {
  refreshCalls: string[] = [];
  exchanges: { code: string; verifier: string }[] = [];
  revoked: string[] = [];
  accessTtlMs = HOUR;
  /** The account the next code exchange logs into. */
  subject = ASH.sub;
  nextError: Error | undefined;
  revokeError: Error | undefined;
  omitRefreshToken = false;
  /** Holds refreshes until released, to exercise concurrency. */
  gate: Promise<void> | undefined;
  private serial = 0;
  private owners = new Map<string, string>();

  authorizeUrl(challenge: string, state: string) {
    return `https://access.pokemon.com/oauth2/auth?code_challenge=${challenge}&state=${state}`;
  }

  async exchangeCode(code: string, verifier: string) {
    this.exchanges.push({ code, verifier });
    return this.issue(this.subject);
  }

  async refresh(refreshToken: string) {
    this.refreshCalls.push(refreshToken);
    await this.gate;
    return this.issue(this.owners.get(refreshToken) ?? 'unknown');
  }

  async revoke(refreshToken: string) {
    if (this.revokeError) throw this.revokeError;
    this.revoked.push(refreshToken);
  }

  private issue(subject: string): TokenGrant {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = undefined;
      throw err;
    }
    this.serial += 1;
    const refreshToken = this.omitRefreshToken ? null : `ory_rt_${this.serial}`;
    if (refreshToken) this.owners.set(refreshToken, subject);
    return { accessToken: `access-${this.serial}`, expiresAt: new Date(clock.getTime() + this.accessTtlMs), subject, refreshToken };
  }
}

function build(): PokemonConnectionService {
  return createPokemonConnectionService({
    db: database.db,
    vault,
    oauth,
    gateway: (tokens: TokenProvider, connectionId: number) => {
      const who = async () => {
        const { subject } = await tokens.getAccessToken(connectionId);
        const p = professors.get(subject);
        if (!p) throw new Error(`no fake professor for ${subject}`);
        return p;
      };
      return {
        async listLeagues() {
          const p = await who();
          leagueCalls.push(p.playerId);
          leaguesInFlight += 1;
          mostLeaguesInFlight = Math.max(mostLeaguesInFlight, leaguesInFlight);
          try {
            // A macrotask, so reads started together would overlap here.
            await new Promise((r) => setTimeout(r, 0));
            if (p.leagues instanceof Error) throw p.leagues;
            return p.leagues;
          } finally {
            leaguesInFlight -= 1;
          }
        },
        async getProfessorProfile() {
          const p = await who();
          profileCalls.push(p.playerId);
          if (profileError) throw profileError;
          return { playerId: p.playerId as never, name: p.name };
        },
      };
    },
    accounts: { actor: (id: number) => ACTORS.get(id) ?? null },
    now: () => clock,
    log,
  });
}

const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));

interface Row {
  id: number;
  professor_player_id: string | null;
  professor_name: string | null;
  professor_full_name: string | null;
  refresh_token_ciphertext: Buffer;
  status: string;
  status_reason: string | null;
  ptc_user_id: string;
  last_refreshed_at: number;
}
const rows = () => database.sqlite.prepare('select * from pokemon_connection order by id').all() as Row[];
const rowOf = (playerId: string) => rows().find((r) => r.professor_player_id === playerId);
const storedRefreshToken = (playerId: string) => {
  const r = rowOf(playerId)!;
  return vault.decrypt(r.refresh_token_ciphertext, connectionAad(r.id));
};
const binding = () => database.sqlite.prepare('select * from league_upstream where league_id = ?').get(L) as { activity_group_id: string } | undefined;
const membershipOf = (p: Professor) =>
  database.sqlite.prepare('select status, can_submit, checked_at from league_membership where connection_id = ?').get(idOf(p)) as
    | { status: string; can_submit: number; checked_at: number | null }
    | undefined;
const idOf = (p: Professor) => rowOf(p.playerId)!.id;

/** Runs the whole connect flow the way the Settings page does, logging into `as`. */
async function connect(as: Professor = ASH, svc = service, actor = OWNER) {
  oauth.subject = as.sub;
  const { authorizeUrl } = svc.startConnect(actor.userId);
  const state = new URL(authorizeUrl).searchParams.get('state');
  return svc.completeConnect(L, actor, `https://play-tools.pokemon.com/loggedIn?code=code-${state}&state=${state}&scope=openid`);
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
  for (const a of ACTORS.values()) {
    database.sqlite.prepare('insert into app_user (id, username, password_hash, role, created_at) values (?, ?, ?, ?, 1)').run(a.userId, a.username, 'h', a.role);
  }
  vault = tokenVault(randomBytes(32).toString('base64'));
  clock = new Date('2026-10-14T22:00:00Z');
  oauth = new FakeOAuth();
  professors = new Map([ASH, BROCK].map((p) => [p.sub, { ...p }]));
  profileError = undefined;
  profileCalls = [];
  leagueCalls = [];
  leaguesInFlight = 0;
  mostLeaguesInFlight = 0;
  log = { warn: vi.fn(), info: vi.fn() };
  service = build();
});
afterEach(() => database.close());

describe("league (the league's activity group, naming no connection)", () => {
  it('is null before a league is chosen', () => {
    expect(service.league(L)).toBeNull();
  });

  it('is the chosen activity group, without any permission of its own', async () => {
    await connect(ASH);
    expect(service.league(L)).toEqual({ id: STORE.id, name: STORE.name, displayId: STORE.displayId });
  });

  it('stays chosen when every connection is disconnected', async () => {
    await connect(ASH);
    await service.disconnect(L, OWNER, ASH.playerId);
    expect(service.league(L)).toEqual({ id: STORE.id, name: STORE.name, displayId: STORE.displayId });
  });
});

describe('connect flow (§4.1, paste-back)', () => {
  it('starts with an authorize URL carrying an S256 challenge and state, and stores nothing', () => {
    const url = new URL(service.startConnect(USER).authorizeUrl);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{16,}$/);
    expect(rows()).toEqual([]);
  });

  it('redeems the code with the verifier behind the challenge, identifies the professor, and stores the token encrypted', async () => {
    const { authorizeUrl } = service.startConnect(USER);
    const params = new URL(authorizeUrl).searchParams;

    const result = await service.completeConnect(L, OWNER, `https://play-tools.pokemon.com/loggedIn?code=abc&state=${params.get('state')}`);

    expect(oauth.exchanges).toHaveLength(1);
    expect(oauth.exchanges[0]!.code).toBe('abc');
    expect(s256Challenge(oauth.exchanges[0]!.verifier)).toBe(params.get('code_challenge'));
    expect(result).toEqual({
      outcome: 'added',
      connection: {
        id: idOf(ASH),
        professorPlayerId: '0012345',
        professorName: null,
        professorFullName: null,
        status: 'connected',
        reason: null,
        connectedAt: clock,
        lastRefreshedAt: clock,
        userId: OWNER.userId,
        mine: true,
        membership: 'member',
        canSubmit: true,
      },
    });
    expect(rowOf('0012345')).toMatchObject({ ptc_user_id: ASH.sub, professor_name: null });
    expect(rowOf('0012345')!.refresh_token_ciphertext.toString('latin1')).not.toContain('ory_rt_1');
    expect(storedRefreshToken('0012345')).toBe('ory_rt_1');
  });

  it("never takes a name from Pokémon, even when the profile carries one (Q5: names come from the organizer)", async () => {
    expect(professors.get(ASH.sub)!.name).toBe('Ash Ketchum');
    const { connection } = await connect(ASH);
    expect(connection).toMatchObject({ professorPlayerId: '0012345', professorName: null });
  });

  it.each([
    ['no player id upstream', new PokemonUpstreamError('unexpected_shape', 'no owner'), 'profile_unavailable'],
    ['Pokémon unreachable while identifying', new PokemonUpstreamError('unavailable', 'down'), 'upstream_unavailable'],
  ])('fails the connect on %s, storing nothing and revoking the fresh login', async (_case, error, code) => {
    profileError = error;
    const err = await rejection(connect(ASH));
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(code);
    expect(rows()).toEqual([]);
    expect(oauth.revoked).toEqual(['ory_rt_1']);
  });

  it('never exposes a token in what it returns', async () => {
    expect(JSON.stringify(await connect())).not.toMatch(/ory_rt|access-/);
  });

  it('leaves the league unchosen when the professor has several leagues, and the connection unknown', async () => {
    professors.get(ASH.sub)!.leagues = [STORE, OTHER_STORE];
    expect((await connect()).connection).toMatchObject({ membership: 'unknown', canSubmit: false });
    expect(binding()).toBeUndefined();
  });

  it('still connects when league discovery fails; the league can be picked later', async () => {
    professors.get(ASH.sub)!.leagues = new PokemonUpstreamError('unavailable', 'down');
    const { connection } = await connect();
    expect(connection.status).toBe('connected');
    expect(binding()).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith('League discovery after connecting failed; pick the league in Settings (down).', {
      err: expect.any(PokemonUpstreamError),
    });
  });

  it.each([
    ['not a URL', 'hello'],
    ['another site', 'https://evil.example/loggedIn?code=a&state=b'],
    ['a login error', 'https://play-tools.pokemon.com/loggedIn?error=access_denied'],
  ])('refuses %s with invalid_url', async (_label, pasted) => {
    service.startConnect(USER);
    const err = await rejection(service.completeConnect(L, OWNER, pasted));
    expect((err as ConnectError).code).toBe('invalid_url');
    expect(oauth.exchanges).toEqual([]);
  });

  it('refuses a state it never issued', async () => {
    service.startConnect(USER);
    const err = await rejection(service.completeConnect(L, OWNER, 'https://play-tools.pokemon.com/loggedIn?code=a&state=forged'));
    expect((err as ConnectError).code).toBe('unknown_attempt');
    expect(oauth.exchanges).toEqual([]);
  });

  it("refuses a state started by another app user (bound to the starter's session)", async () => {
    const { authorizeUrl } = service.startConnect(USER);
    const state = new URL(authorizeUrl).searchParams.get('state');
    const err = await rejection(service.completeConnect(L, MISTY, `https://play-tools.pokemon.com/loggedIn?code=a&state=${state}`));
    expect((err as ConnectError).code).toBe('unknown_attempt');
    expect(oauth.exchanges).toEqual([]);
  });

  it('uses each attempt once: a replayed paste creates no second connection', async () => {
    const { authorizeUrl } = service.startConnect(USER);
    const pasted = `https://play-tools.pokemon.com/loggedIn?code=a&state=${new URL(authorizeUrl).searchParams.get('state')}`;
    await service.completeConnect(L, OWNER, pasted);

    const err = await rejection(service.completeConnect(L, OWNER, pasted));
    expect((err as ConnectError).code).toBe('unknown_attempt');
    expect(oauth.exchanges).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  it('uses each attempt once, even when the exchange failed', async () => {
    const { authorizeUrl } = service.startConnect(USER);
    const pasted = `https://play-tools.pokemon.com/loggedIn?code=a&state=${new URL(authorizeUrl).searchParams.get('state')}`;
    oauth.nextError = new PokemonUpstreamError('unavailable', 'down');
    await rejection(service.completeConnect(L, OWNER, pasted));
    expect(((await rejection(service.completeConnect(L, OWNER, pasted))) as ConnectError).code).toBe('unknown_attempt');
  });

  it('expires an attempt after 10 minutes, and accepts one at exactly 10', async () => {
    const late = new URL(service.startConnect(USER).authorizeUrl).searchParams.get('state');
    advance(10 * MIN + 1);
    const err = await rejection(service.completeConnect(L, OWNER, `https://play-tools.pokemon.com/loggedIn?code=a&state=${late}`));
    expect((err as ConnectError).code).toBe('expired');

    const onTime = new URL(service.startConnect(USER).authorizeUrl).searchParams.get('state');
    advance(10 * MIN);
    await expect(service.completeConnect(L, OWNER, `https://play-tools.pokemon.com/loggedIn?code=a&state=${onTime}`)).resolves.toMatchObject({
      outcome: 'added',
    });
  });

  it('reports a code Pokémon refuses as code_rejected and stores nothing', async () => {
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'already used');
    expect(((await rejection(connect())) as ConnectError).code).toBe('code_rejected');
    expect(rows()).toEqual([]);
  });

  it('fails without storing anything when Hydra grants no refresh token (offline scope missing)', async () => {
    oauth.omitRefreshToken = true;
    expect(((await rejection(connect())) as PokemonUpstreamError).code).toBe('unexpected_shape');
    expect(rows()).toEqual([]);
  });
});

describe('several professors', () => {
  it("adds a second professor without touching the first one's token, status or league", async () => {
    await connect(ASH);
    const before = rowOf(ASH.playerId);

    const { outcome, connection } = await connect(BROCK);

    expect(outcome).toBe('added');
    expect(connection).toMatchObject({ professorPlayerId: '222', membership: 'outside', canSubmit: false });
    expect(rows()).toHaveLength(2);
    expect(rowOf(ASH.playerId)).toEqual(before);
    expect(binding()!.activity_group_id).toBe(STORE.id);
  });

  it('reconnecting a professor replaces their token, clears needs_reconnect and keeps the league', async () => {
    await connect(ASH);
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'revoked');
    advance(HOUR);
    await rejection(service.getAccessToken(idOf(ASH)));
    expect(rowOf(ASH.playerId)!.status).toBe('needs_reconnect');

    professors.get(ASH.sub)!.leagues = [STORE, OTHER_STORE]; // would leave a fresh connection unchosen
    const { outcome, connection } = await connect(ASH);

    expect(outcome).toBe('reconnected');
    expect(connection).toMatchObject({ status: 'connected', reason: null, membership: 'member' });
    expect(binding()!.activity_group_id).toBe(STORE.id);
    expect(rows()).toHaveLength(1);
    expect(storedRefreshToken(ASH.playerId)).toBe('ory_rt_2');
  });

  it("keeps the organizer's display name across a reconnect", async () => {
    await connect(ASH);
    service.renameProfessor(L, OWNER, ASH.playerId, { name: 'Ash K.' });
    await connect(ASH);
    expect(rowOf(ASH.playerId)!.professor_name).toBe('Ash K.');
  });

  it("keeps the professor's full name across a reconnect, and never takes one from Pokémon", async () => {
    await connect(ASH);
    expect(rowOf(ASH.playerId)!.professor_full_name).toBeNull();
    service.renameProfessor(L, OWNER, ASH.playerId, { fullName: 'Ash Ketchum' });
    await connect(ASH);
    expect(rowOf(ASH.playerId)!.professor_full_name).toBe('Ash Ketchum');
  });

  it('lists the connections sorted by display name, unnamed ones by player id, with each one’s membership', async () => {
    await connect(BROCK);
    await connect(ASH);
    professors.set('sub-misty', { sub: 'sub-misty', playerId: '0000444', name: null, leagues: [] });
    await connect(professors.get('sub-misty')!);
    service.renameProfessor(L, OWNER, BROCK.playerId, { name: 'Brock Harrison' });
    service.renameProfessor(L, OWNER, ASH.playerId, { name: 'Ash Ketchum' });
    expect(service.listConnections(L, OWNER).map((c) => [c.professorName ?? c.professorPlayerId, c.membership])).toEqual([
      ['Ash Ketchum', 'outside'],
      ['Brock Harrison', 'member'],
      ['0000444', 'outside'],
    ]);
  });

  it('caps an install at 10 connections; a known professor can still reconnect', async () => {
    for (let i = 1; i <= 10; i++) {
      professors.set(`sub-${i}`, { sub: `sub-${i}`, playerId: String(1000 + i), name: `Prof ${i}`, leagues: [] });
      await connect(professors.get(`sub-${i}`)!);
    }
    const err = await rejection(connect(ASH));
    expect((err as ConnectError).code).toBe('connection_limit');
    expect(rows()).toHaveLength(10);
    expect(oauth.revoked).toEqual([expect.stringMatching(/^ory_rt_/)]);

    await expect(connect(professors.get('sub-3')!)).resolves.toMatchObject({ outcome: 'reconnected' });
  });

  it('lets only one of two concurrent connects past the cap', async () => {
    for (let i = 1; i <= 9; i++) {
      professors.set(`sub-${i}`, { sub: `sub-${i}`, playerId: String(1000 + i), name: `Prof ${i}`, leagues: [] });
      await connect(professors.get(`sub-${i}`)!);
    }
    const a = connect(ASH);
    const b = connect(BROCK);
    const settled = await Promise.allSettled([a, b]);
    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(rows()).toHaveLength(10);
  });

  it('keeps one row when the same professor connects twice at once', async () => {
    const both = await Promise.all([connect(ASH), connect(ASH)]);
    expect(rows()).toHaveLength(1);
    expect(both.map((r) => r.outcome).sort()).toEqual(['added', 'reconnected']);
  });
});

describe('getAccessToken (TokenProvider contract, per connection)', () => {
  it('throws not_connected for a connection that does not exist', async () => {
    expect(((await rejection(service.getAccessToken(42))) as PokemonUpstreamError).code).toBe('not_connected');
  });

  it('serves the token from the connect while it has ≥ 2 minutes left, without refreshing', async () => {
    await connect();
    advance(HOUR - 2 * MIN);
    expect(await service.getAccessToken(idOf(ASH))).toEqual({ value: 'access-1', expiresAt: new Date('2026-10-14T23:00:00Z'), subject: ASH.sub });
    expect(oauth.refreshCalls).toEqual([]);
  });

  it('refreshes once under 2 minutes are left, persisting the rotated refresh token before handing out the access token', async () => {
    await connect();
    advance(HOUR - 2 * MIN + 1);
    const token = await service.getAccessToken(idOf(ASH));
    expect(oauth.refreshCalls).toEqual(['ory_rt_1']);
    expect(token.value).toBe('access-2');
    expect(storedRefreshToken(ASH.playerId)).toBe('ory_rt_2');
    expect(rowOf(ASH.playerId)!.last_refreshed_at).toBe(Math.floor(clock.getTime() / 1000));
  });

  it('uses the rotated refresh token for the next refresh (never replays an old one)', async () => {
    await connect();
    advance(HOUR);
    await service.getAccessToken(idOf(ASH));
    advance(HOUR);
    await service.getAccessToken(idOf(ASH));
    expect(oauth.refreshCalls).toEqual(['ory_rt_1', 'ory_rt_2']);
  });

  it('keeps the current refresh token when Hydra does not rotate it', async () => {
    await connect();
    oauth.omitRefreshToken = true;
    advance(HOUR);
    await service.getAccessToken(idOf(ASH));
    expect(storedRefreshToken(ASH.playerId)).toBe('ory_rt_1');
  });

  it('refreshes each professor once under concurrent use, and never hands one professor the other\'s token', async () => {
    await connect(ASH);
    await connect(BROCK);
    advance(HOUR);
    let release!: () => void;
    oauth.gate = new Promise((r) => (release = r));

    const ash = [1, 2, 3].map(() => service.getAccessToken(idOf(ASH)));
    const brock = [1, 2, 3].map(() => service.getAccessToken(idOf(BROCK)));
    release();
    const [ashTokens, brockTokens] = await Promise.all([Promise.all(ash), Promise.all(brock)]);

    expect(oauth.refreshCalls.sort()).toEqual(['ory_rt_1', 'ory_rt_2']);
    expect(new Set(ashTokens.map((t) => t.subject))).toEqual(new Set([ASH.sub]));
    expect(new Set(brockTokens.map((t) => t.subject))).toEqual(new Set([BROCK.sub]));
    expect(new Set(ashTokens.map((t) => t.value)).size).toBe(1);
    expect(oauth.refreshCalls).not.toContain(storedRefreshToken(ASH.playerId));
    expect(oauth.refreshCalls).not.toContain(storedRefreshToken(BROCK.playerId));
  });

  it('hands out no token when the rotated refresh token cannot be saved', async () => {
    await connect();
    advance(HOUR);
    database.sqlite.exec("create trigger no_writes before update on pokemon_connection begin select raise(abort, 'disk I/O error'); end");

    await expect(service.getAccessToken(idOf(ASH))).rejects.toThrow(/disk I\/O error/);
    database.sqlite.exec('drop trigger no_writes');
    expect(storedRefreshToken(ASH.playerId)).toBe('ory_rt_1');

    // Nothing was cached either: the next caller goes back to Hydra.
    await service.getAccessToken(idOf(ASH));
    expect(oauth.refreshCalls).toHaveLength(2);
  });

  it("marks only that professor needs_reconnect on invalid_grant; the other keeps working", async () => {
    await connect(ASH);
    await connect(BROCK);
    advance(HOUR);
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'Pokémon no longer accepts this login');

    expect(((await rejection(service.getAccessToken(idOf(BROCK)))) as PokemonUpstreamError).code).toBe('needs_reconnect');
    expect(rowOf(BROCK.playerId)).toMatchObject({ status: 'needs_reconnect', status_reason: expect.stringMatching(/no longer accepts/) });
    expect(rowOf(ASH.playerId)!.status).toBe('connected');
    expect((await service.getAccessToken(idOf(ASH))).subject).toBe(ASH.sub);

    expect(((await rejection(service.getAccessToken(idOf(BROCK)))) as PokemonUpstreamError).code).toBe('needs_reconnect');
    expect(oauth.refreshCalls).toHaveLength(2);
  });

  it("refuses a ciphertext moved onto another professor's row", async () => {
    await connect(ASH);
    await connect(BROCK);
    database.sqlite
      .prepare('update pokemon_connection set refresh_token_ciphertext = ? where id = ?')
      .run(rowOf(ASH.playerId)!.refresh_token_ciphertext, idOf(BROCK));
    const restarted = build();

    expect(((await rejection(restarted.getAccessToken(idOf(BROCK)))) as PokemonUpstreamError).code).toBe('needs_reconnect');
    expect(oauth.refreshCalls).toEqual([]);
  });

  it('marks needs_reconnect when the stored token no longer decrypts (vault key replaced)', async () => {
    await connect();
    vault = tokenVault(randomBytes(32).toString('base64'));
    const restarted = build();
    expect(((await rejection(restarted.getAccessToken(idOf(ASH)))) as PokemonUpstreamError).code).toBe('needs_reconnect');
    expect(rowOf(ASH.playerId)).toMatchObject({ status: 'needs_reconnect', status_reason: expect.stringMatching(/key/) });
  });

  it('passes a transient failure through, stays connected, and tries again next call', async () => {
    await connect();
    advance(HOUR);
    oauth.nextError = new PokemonUpstreamError('unavailable', 'down');
    expect(((await rejection(service.getAccessToken(idOf(ASH)))) as PokemonUpstreamError).code).toBe('unavailable');
    expect(rowOf(ASH.playerId)!.status).toBe('connected');
    expect((await service.getAccessToken(idOf(ASH))).value).toBe('access-2');
  });

  it('refreshes from the stored token after a restart (no cached access token)', async () => {
    await connect();
    const restarted = build();
    expect((await restarted.getAccessToken(idOf(ASH))).value).toBe('access-2');
    expect(oauth.refreshCalls).toEqual(['ory_rt_1']);
  });

  it("never re-reads an identified professor's identity on a refresh, even without a display name (one call per connect)", async () => {
    await connect(ASH);
    expect(profileCalls).toEqual([ASH.playerId]);
    advance(HOUR);
    await service.getAccessToken(idOf(ASH));
    advance(HOUR);
    await service.keepAliveAll();
    expect(oauth.refreshCalls).toHaveLength(2);
    expect(profileCalls).toEqual([ASH.playerId]);
  });
});

describe('keepAliveAll (hourly task)', () => {
  it('runs the 45-minute rule for every professor, one at a time', async () => {
    oauth.accessTtlMs = 24 * HOUR;
    await connect(ASH);
    advance(30 * MIN);
    await connect(BROCK);
    advance(20 * MIN); // Ash at 50 min, Brock at 20 min

    expect(await service.keepAliveAll()).toEqual([
      { connectionId: idOf(ASH), professorPlayerId: ASH.playerId, outcome: 'refreshed' },
      { connectionId: idOf(BROCK), professorPlayerId: BROCK.playerId, outcome: 'skipped_recent' },
    ]);
    expect(oauth.refreshCalls).toEqual(['ory_rt_1']);
  });

  it('skips a professor who needs a reconnect, without calling Hydra', async () => {
    await connect(ASH);
    advance(HOUR);
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'revoked');
    await rejection(service.getAccessToken(idOf(ASH)));
    advance(HOUR);

    expect(await service.keepAliveAll()).toEqual([{ connectionId: idOf(ASH), professorPlayerId: ASH.playerId, outcome: 'needs_reconnect' }]);
    expect(oauth.refreshCalls).toHaveLength(1);
  });

  it("keeps going after one professor's failure", async () => {
    await connect(ASH);
    await connect(BROCK);
    advance(HOUR);
    oauth.nextError = new PokemonUpstreamError('unavailable', 'Pokémon answered 503');

    expect(await service.keepAliveAll()).toEqual([
      { connectionId: idOf(ASH), professorPlayerId: ASH.playerId, outcome: 'failed', message: 'Pokémon answered 503' },
      { connectionId: idOf(BROCK), professorPlayerId: BROCK.playerId, outcome: 'refreshed' },
    ]);
  });

  it('reports needs_reconnect when a refresh is refused', async () => {
    await connect(ASH);
    advance(HOUR);
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'revoked');
    expect((await service.keepAliveAll())[0]!.outcome).toBe('needs_reconnect');
    expect(rowOf(ASH.playerId)!.status).toBe('needs_reconnect');
  });

  it('does nothing without connections', async () => {
    expect(await service.keepAliveAll()).toEqual([]);
  });

  it("waits for a professor's in-flight refresh before a reconnect replaces their token, so the reconnect's token is the one kept", async () => {
    await connect(ASH);
    advance(HOUR);
    let release!: () => void;
    oauth.gate = new Promise((r) => (release = r));

    const keepAlive = service.keepAliveAll(); // refreshing ory_rt_1, held by the gate
    const reconnect = connect(ASH); // its exchange issues ory_rt_2
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([keepAlive, reconnect]);

    expect(storedRefreshToken(ASH.playerId)).toBe('ory_rt_2');
  });
});

describe('the league picker (owner only: the leagues of their own connections)', () => {
  const THIRD: League = { id: 'group-3', name: 'Pewter Gym', displayId: 'L7100', canSubmit: true };
  const markNeedsReconnect = (p: Professor) =>
    database.sqlite.prepare("update pokemon_connection set status = 'needs_reconnect' where professor_player_id = ?").run(p.playerId);

  it("offers every league of the owner's connections once, never a professor's, and never reads as a professor", async () => {
    professors.get(ASH.sub)!.leagues = [STORE, OTHER_STORE];
    await connect(ASH);
    professors.get(BROCK.sub)!.leagues = [OTHER_STORE, THIRD];
    await connect(BROCK);
    const misty: Professor = { sub: 'sub-misty', playerId: '0000444', name: null, leagues: [{ id: 'group-9', name: 'Cerulean', displayId: 'L9', canSubmit: true }] };
    professors.set(misty.sub, misty);
    await connect(misty, service, MISTY);
    leagueCalls = [];

    expect(await service.listUpstreamLeagues(L, OWNER)).toEqual({ leagues: [STORE, OTHER_STORE, THIRD], selectedId: null, excluded: [] });
    expect(leagueCalls.sort()).toEqual([ASH.playerId, BROCK.playerId].sort());
  });

  it('says which league is chosen', async () => {
    await connect(ASH);
    expect(await service.listUpstreamLeagues(L, OWNER)).toEqual({ leagues: [STORE], selectedId: 'group-1', excluded: [] });
  });

  it("leaves out an owner connection that needs a reconnect, naming it, without calling Pokémon as it", async () => {
    professors.get(ASH.sub)!.leagues = [STORE, OTHER_STORE];
    await connect(ASH);
    await connect(BROCK);
    service.renameProfessor(L, OWNER, BROCK.playerId, { name: 'Brock Harrison' });
    markNeedsReconnect(BROCK);
    leagueCalls = [];

    expect(await service.listUpstreamLeagues(L, OWNER)).toEqual({
      leagues: [STORE, OTHER_STORE],
      selectedId: null,
      excluded: [{ playerId: BROCK.playerId, name: 'Brock Harrison' }],
    });
    expect(leagueCalls).toEqual([ASH.playerId]);
  });

  it("fails the list when one of the owner's connections can't be read for any other reason", async () => {
    await connect(ASH);
    await connect(BROCK);
    professors.get(BROCK.sub)!.leagues = new PokemonUpstreamError('unavailable', 'down');
    await expect(service.listUpstreamLeagues(L, OWNER)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('chooses one of those leagues, and says how many connections it could not check', async () => {
    professors.get(ASH.sub)!.leagues = [STORE, OTHER_STORE];
    await connect(ASH);
    await connect(BROCK);

    expect(await service.selectLeague(L, OWNER, 'group-2')).toEqual({ league: { id: 'group-2', name: 'Game Den', displayId: 'L7000' }, unchecked: 0 });
    expect(binding()).toMatchObject({ activity_group_id: 'group-2', activity_group_name: 'Game Den' });
  });

  it("refuses a league none of the owner's connections is in, keeping the current one", async () => {
    await connect(ASH);
    const misty: Professor = { sub: 'sub-misty', playerId: '0000444', name: null, leagues: [OTHER_STORE] };
    professors.set(misty.sub, misty);
    await connect(misty, service, MISTY);

    await expect(service.selectLeague(L, OWNER, 'group-2')).rejects.toBeInstanceOf(LeagueNotFoundError);
    expect(binding()!.activity_group_id).toBe('group-1');
  });

  it("chooses the league after an owner's connect when their connections are in exactly one", async () => {
    professors.get(ASH.sub)!.leagues = [STORE, OTHER_STORE];
    await connect(ASH);
    expect(binding()).toBeUndefined();
    professors.get(ASH.sub)!.leagues = [STORE];
    professors.get(BROCK.sub)!.leagues = [STORE];
    await connect(ASH);
    expect(binding()).toMatchObject({ activity_group_id: 'group-1' });
  });

  it("chooses nothing after a professor's connect", async () => {
    const misty: Professor = { sub: 'sub-misty', playerId: '0000444', name: null, leagues: [STORE] };
    professors.set(misty.sub, misty);
    await connect(misty, service, MISTY);
    expect(binding()).toBeUndefined();
  });
});

describe('listActingConnections (who can read and act upstream)', () => {
  it('lists every connection with its professor and status, never a token', async () => {
    await connect(ASH);
    await connect(BROCK);
    service.renameProfessor(L, OWNER, BROCK.playerId, { name: 'Brock Harrison' });
    database.sqlite.prepare("update pokemon_connection set status = 'needs_reconnect' where professor_player_id = ?").run(BROCK.playerId);

    const listed = service.listActingConnections();
    expect(listed).toEqual([
      { id: idOf(ASH), professorPlayerId: ASH.playerId, professorName: null, status: 'connected', userId: OWNER.userId, membership: 'member', canSubmit: true },
      {
        id: idOf(BROCK),
        professorPlayerId: BROCK.playerId,
        professorName: 'Brock Harrison',
        status: 'needs_reconnect',
        userId: OWNER.userId,
        membership: 'outside',
        canSubmit: false,
      },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/ory_rt|access-/);
  });
});

describe('disconnect', () => {
  it("revokes that professor's token and forgets only them and their membership, keeping the league", async () => {
    await connect(ASH);
    await connect(BROCK);

    expect(await service.disconnect(L, OWNER, ASH.playerId)).toEqual({ revoked: true });

    expect(oauth.revoked).toEqual(['ory_rt_1']);
    expect(rows().map((r) => r.professor_player_id)).toEqual(['222']);
    expect(database.sqlite.prepare('select count(*) n from league_membership where connection_id = 1').get()).toEqual({ n: 0 });
    expect(binding()!.activity_group_id).toBe(STORE.id);
    expect(((await rejection(service.getAccessToken(1))) as PokemonUpstreamError).code).toBe('not_connected');
  });

  it('still forgets the token locally when Hydra cannot be reached', async () => {
    await connect();
    oauth.revokeError = new PokemonUpstreamError('unavailable', 'down');
    expect(await service.disconnect(L, OWNER, ASH.playerId)).toEqual({ revoked: false });
    expect(rows()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith('Could not revoke the refresh token at Pokémon; forgetting it locally anyway (down).', {
      err: expect.any(PokemonUpstreamError),
    });
  });

  it('refuses an unknown professor', async () => {
    await expect(service.disconnect(L, OWNER, '999')).rejects.toBeInstanceOf(ConnectionNotFoundError);
    expect(oauth.revoked).toEqual([]);
  });
});

describe('the connection carried over from v1 (ADR-0008 upgrade)', () => {
  /** What migration 0009 leaves behind: an unidentified row whose token is sealed with the league id. */
  function carriedOver(opts: { status?: 'connected' | 'needs_reconnect'; boundTo?: League } = {}) {
    const id = database.sqlite
      .prepare(
        `insert into pokemon_connection (user_id, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at)
         values (1, ?, ?, ?, ?, ?)`,
      )
      .run(ASH.sub, vault.encrypt('ory_rt_v1', L), opts.status ?? 'connected', Math.floor(clock.getTime() / 1000), Math.floor(clock.getTime() / 1000))
      .lastInsertRowid as number;
    // As migration 0020 leaves it: the connection that submitted before is a member that may submit.
    database.sqlite
      .prepare('insert into league_membership (connection_id, league_id, status, can_submit) values (?, ?, ?, ?)')
      .run(id, L, opts.boundTo ? 'member' : 'unknown', Number(opts.boundTo?.canSubmit ?? false));
    if (opts.boundTo) {
      database.sqlite
        .prepare('insert into league_upstream (league_id, activity_group_id, activity_group_name, activity_group_display_id) values (?, ?, ?, ?)')
        .run(L, opts.boundTo.id, opts.boundTo.name, opts.boundTo.displayId);
    }
    return id;
  }
  /** Teaches the fake Hydra that the v1 token belongs to Ash. */
  async function hydraKnowsV1() {
    (oauth as unknown as { owners: Map<string, string> }).owners.set('ory_rt_v1', ASH.sub);
  }

  it('re-seals the token under its own row before anything refreshes it, then identifies the professor on the first refresh', async () => {
    const id = carriedOver({ boundTo: STORE });
    await hydraKnowsV1();

    expect(service.resealCarriedOver(L)).toBe(1);
    expect(vault.decrypt(rows()[0]!.refresh_token_ciphertext, connectionAad(id))).toBe('ory_rt_v1');
    expect(() => vault.decrypt(rows()[0]!.refresh_token_ciphertext, L)).toThrow();

    await service.identifyCarriedOver();

    expect(oauth.refreshCalls).toEqual(['ory_rt_v1']);
    expect(rows()[0]).toMatchObject({ id, professor_player_id: ASH.playerId, professor_name: null, status: 'connected' });
    expect(service.listActingConnections()).toEqual([expect.objectContaining({ id, professorPlayerId: ASH.playerId, membership: 'member', canSubmit: true })]);
  });

  it('re-seals nothing twice', () => {
    carriedOver();
    expect(service.resealCarriedOver(L)).toBe(1);
    expect(service.resealCarriedOver(L)).toBe(0);
  });

  it('lists an unidentified connection with no player id until it is identified', async () => {
    carriedOver({ boundTo: STORE });
    expect(service.listConnections(L, OWNER)).toEqual([expect.objectContaining({ professorPlayerId: null, professorName: null, membership: 'member' })]);
  });

  it('marks it needs_reconnect when its refresh is refused, leaving it unidentified', async () => {
    carriedOver({ boundTo: STORE });
    await hydraKnowsV1();
    service.resealCarriedOver(L);
    oauth.nextError = new PokemonUpstreamError('needs_reconnect', 'revoked');

    await service.identifyCarriedOver();

    expect(rows()[0]).toMatchObject({ professor_player_id: null, status: 'needs_reconnect' });
  });

  it('is claimed by the next connect when it needs a reconnect, keeping the league binding', async () => {
    const id = carriedOver({ status: 'needs_reconnect', boundTo: STORE });
    service.resealCarriedOver(L);

    const { outcome, connection } = await connect(BROCK);

    expect(outcome).toBe('reconnected');
    expect(rows()).toHaveLength(1);
    expect(connection).toMatchObject({ id, professorPlayerId: BROCK.playerId, status: 'connected', userId: OWNER.userId });
    expect(binding()!.activity_group_id).toBe(STORE.id);
  });

  it("merges into the professor's own connection when both turn out to be the same person, keeping the league", async () => {
    carriedOver({ boundTo: STORE });
    await hydraKnowsV1();
    service.resealCarriedOver(L);
    professors.get(ASH.sub)!.leagues = [STORE, OTHER_STORE];
    // A fresh connect for Ash lands first, as a separate row (the old one was healthy, so it isn't claimed).
    oauth.subject = 'sub-ash-again';
    professors.set('sub-ash-again', { ...ASH, sub: 'sub-ash-again' });
    await connect(professors.get('sub-ash-again')!);
    expect(rows()).toHaveLength(2);

    await service.identifyCarriedOver();

    expect(rows()).toEqual([expect.objectContaining({ professor_player_id: ASH.playerId })]);
    // The professor's own connection stays; the carried-over chain (just refreshed to ory_rt_2) is revoked.
    expect(membershipOf(ASH)).toMatchObject({ status: 'member', can_submit: 1 });
    expect(storedRefreshToken(ASH.playerId)).toBe('ory_rt_1');
    expect(oauth.revoked).toEqual(['ory_rt_2']);
  });
});

describe('edge cases', () => {
  it('sets, changes and clears a display name, which shows on the league view and nowhere upstream', async () => {
    await connect(ASH);
    const callsBefore = oauth.refreshCalls.length + profileCalls.length;

    expect(service.renameProfessor(L, OWNER, ASH.playerId, { name: 'Ash Ketchum' })).toMatchObject({ professorPlayerId: ASH.playerId, professorName: 'Ash Ketchum' });
    expect(service.listActingConnections()[0]).toMatchObject({ professorPlayerId: ASH.playerId, professorName: 'Ash Ketchum' });
    expect(service.renameProfessor(L, OWNER, ASH.playerId, { name: 'Ash K.' }).professorName).toBe('Ash K.');
    expect(service.renameProfessor(L, OWNER, ASH.playerId, { name: null }).professorName).toBeNull();

    expect(rowOf(ASH.playerId)!.professor_name).toBeNull();
    expect(oauth.refreshCalls.length + profileCalls.length).toBe(callsBefore);
  });

  it('lets two professors share a display name (it identifies nobody)', async () => {
    await connect(ASH);
    await connect(BROCK);
    service.renameProfessor(L, OWNER, ASH.playerId, { name: 'Prof' });
    service.renameProfessor(L, OWNER, BROCK.playerId, { name: 'Prof' });
    expect(rows().map((r) => r.professor_name)).toEqual(['Prof', 'Prof']);
  });

  it('refuses to name a professor nobody connected', () => {
    expect(() => service.renameProfessor(L, OWNER, '999', { name: 'Nobody' })).toThrow(ConnectionNotFoundError);
    expect(() => service.renameProfessor(L, OWNER, '999', { fullName: 'Nobody' })).toThrow(ConnectionNotFoundError);
    expect(rows()).toEqual([]);
  });

  it('sets and clears the full name on its own, leaving the display name as it is, and sends it nowhere', async () => {
    await connect(ASH);
    service.renameProfessor(L, OWNER, ASH.playerId, { name: 'Ash K.' });
    const callsBefore = oauth.refreshCalls.length + profileCalls.length;

    expect(service.renameProfessor(L, OWNER, ASH.playerId, { fullName: 'Ash Ketchum' })).toMatchObject({
      professorName: 'Ash K.',
      professorFullName: 'Ash Ketchum',
    });
    expect(service.listConnections(L, OWNER)).toEqual([expect.objectContaining({ professorName: 'Ash K.', professorFullName: 'Ash Ketchum' })]);
    expect(service.renameProfessor(L, OWNER, ASH.playerId, { fullName: null })).toMatchObject({ professorName: 'Ash K.', professorFullName: null });

    expect(rowOf(ASH.playerId)).toMatchObject({ professor_name: 'Ash K.', professor_full_name: null });
    expect(oauth.refreshCalls.length + profileCalls.length).toBe(callsBefore);
  });

  it('changes the display name alone without touching the full name, or both at once', async () => {
    await connect(ASH);
    service.renameProfessor(L, OWNER, ASH.playerId, { name: 'Ash K.', fullName: 'Ash Ketchum' });
    expect(service.renameProfessor(L, OWNER, ASH.playerId, { name: 'Ash' })).toMatchObject({ professorName: 'Ash', professorFullName: 'Ash Ketchum' });
    expect(service.renameProfessor(L, OWNER, ASH.playerId, { name: null, fullName: 'Satoshi Ketchum' })).toMatchObject({
      professorName: null,
      professorFullName: 'Satoshi Ketchum',
    });
  });

  it("keeps the professor's own display name when a carried-over twin merges into them", async () => {
    database.sqlite
      .prepare('insert into pokemon_connection (user_id, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at) values (1, ?, ?, ?, ?, ?)')
      .run(ASH.sub, vault.encrypt('ory_rt_v1', L), 'connected', 1, 1);
    (oauth as unknown as { owners: Map<string, string> }).owners.set('ory_rt_v1', ASH.sub);
    service.resealCarriedOver(L);
    professors.set('sub-ash-again', { ...ASH, sub: 'sub-ash-again' });
    await connect(professors.get('sub-ash-again')!);
    service.renameProfessor(L, OWNER, ASH.playerId, { name: 'Ash Ketchum' });

    await service.identifyCarriedOver();

    expect(rows()).toEqual([expect.objectContaining({ professor_player_id: ASH.playerId, professor_name: 'Ash Ketchum' })]);
  });

  it('still forgets a professor whose token the vault can no longer open, without revoking', async () => {
    await connect(ASH);
    vault = tokenVault(randomBytes(32).toString('base64'));
    const restarted = build();
    expect(await restarted.disconnect(L, OWNER, ASH.playerId)).toEqual({ revoked: false });
    expect(rows()).toEqual([]);
    expect(oauth.revoked).toEqual([]);
  });

  it('identifies a carried-over connection on a later refresh when Pokémon could not say who it was the first time', async () => {
    const id = database.sqlite
      .prepare('insert into pokemon_connection (user_id, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at) values (1, ?, ?, ?, ?, ?)')
      .run(ASH.sub, vault.encrypt('ory_rt_v1', L), 'connected', 1, 1).lastInsertRowid as number;
    (oauth as unknown as { owners: Map<string, string> }).owners.set('ory_rt_v1', ASH.sub);
    service.resealCarriedOver(L);
    profileError = new PokemonUpstreamError('unavailable', 'down');

    await service.identifyCarriedOver();
    expect(rows()[0]).toMatchObject({ id, professor_player_id: null, status: 'connected' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/trying again on the next refresh/), { err: expect.any(PokemonUpstreamError) });

    profileError = undefined;
    advance(HOUR);
    await service.getAccessToken(id);
    expect(rows()[0]).toMatchObject({ id, professor_player_id: ASH.playerId });
  });

  it('leaves a ciphertext that opens under neither key for its first use to mark needs_reconnect', async () => {
    database.sqlite
      .prepare('insert into pokemon_connection (user_id, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at) values (1, ?, ?, ?, ?, ?)')
      .run(ASH.sub, tokenVault(randomBytes(32).toString('base64')).encrypt('ory_rt_x', L), 'connected', 1, 1);
    expect(service.resealCarriedOver(L)).toBe(0);
    await service.identifyCarriedOver();
    expect(rows()[0]).toMatchObject({ status: 'needs_reconnect', status_reason: expect.stringMatching(/key/) });
    expect(oauth.refreshCalls).toEqual([]);
  });
});

const MISTY_ACCOUNT: Professor = { sub: 'sub-misty', playerId: '0000444', name: null, leagues: [STORE] };
const GARY_ACCOUNT: Professor = { sub: 'sub-gary', playerId: '0000555', name: null, leagues: [STORE] };

/** The owner's connection chooses the league (STORE); then each professor connects their own account. */
async function leagueWithProfessors() {
  professors.set(MISTY_ACCOUNT.sub, { ...MISTY_ACCOUNT });
  professors.set(GARY_ACCOUNT.sub, { ...GARY_ACCOUNT });
  await connect(ASH);
  await connect(MISTY_ACCOUNT, service, MISTY);
}

describe('who holds a connection (ADR-0015 §2)', () => {
  it("gives a professor's connect to that professor", async () => {
    await leagueWithProfessors();
    expect(rowOf(MISTY_ACCOUNT.playerId)).toMatchObject({ user_id: MISTY.userId });
    expect(service.listConnections(L, MISTY)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ professorPlayerId: MISTY_ACCOUNT.playerId, mine: true, membership: 'member', canSubmit: true }),
        expect.objectContaining({ professorPlayerId: ASH.playerId, mine: false }),
      ]),
    );
  });

  it("moves the owner's connection to the professor who logs into it, keeping its row and names, and records the move", async () => {
    await connect(ASH);
    service.renameProfessor(L, OWNER, ASH.playerId, { name: 'Ash K.', fullName: 'Ash Ketchum' });
    const before = rowOf(ASH.playerId)!;
    advance(MIN);

    const { outcome, connection } = await connect(ASH, service, MISTY);

    expect(outcome).toBe('claimed');
    expect(connection).toMatchObject({ id: before.id, professorName: 'Ash K.', professorFullName: 'Ash Ketchum', userId: MISTY.userId, mine: true });
    expect(rowOf(ASH.playerId)).toMatchObject({ id: before.id, user_id: MISTY.userId, claimed_from_user_id: OWNER.userId, claimed_at: clock.getTime() / 1000 });
    expect(storedRefreshToken(ASH.playerId)).toBe('ory_rt_2');
    expect(membershipOf(ASH)).toMatchObject({ status: 'member' });
    expect(log.info).toHaveBeenCalledWith(`Pokémon connection for professor ${ASH.playerId} moved from organizer to misty`, {
      professorPlayerId: ASH.playerId,
      fromUser: 'organizer',
      toUser: 'misty',
    });
  });

  it.each([
    ['the owner', OWNER],
    ['another professor', GARY],
  ])("refuses %s a connect for a professor's account, leaving it as it was and revoking the fresh login", async (_who, actor) => {
    await leagueWithProfessors();
    const before = rowOf(MISTY_ACCOUNT.playerId);

    const err = await rejection(connect(MISTY_ACCOUNT, service, actor));

    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe('connection_held');
    expect(rowOf(MISTY_ACCOUNT.playerId)).toEqual(before);
    expect(oauth.revoked).toEqual(['ory_rt_3']);
  });

  it('refuses a professor who holds a connection a second Pokémon account, new or the owner’s', async () => {
    await leagueWithProfessors();

    expect(((await rejection(connect(GARY_ACCOUNT, service, MISTY))) as ConnectError).code).toBe('one_connection_only');
    expect(((await rejection(connect(ASH, service, MISTY))) as ConnectError).code).toBe('one_connection_only');
    expect(rows().map((r) => [r.professor_player_id, (r as unknown as { user_id: number }).user_id])).toEqual([
      [ASH.playerId, OWNER.userId],
      [MISTY_ACCOUNT.playerId, MISTY.userId],
    ]);
    expect(oauth.revoked).toEqual(['ory_rt_3', 'ory_rt_4']);
  });

  it('lets a professor reconnect their own account', async () => {
    await leagueWithProfessors();
    await expect(connect(MISTY_ACCOUNT, service, MISTY)).resolves.toMatchObject({ outcome: 'reconnected' });
  });

  it("never gives a professor the owner's carried-over v1 connection", async () => {
    database.sqlite
      .prepare("insert into pokemon_connection (user_id, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at) values (1, 'sub-old', x'00', 'needs_reconnect', 1, 1)")
      .run();
    professors.set(MISTY_ACCOUNT.sub, { ...MISTY_ACCOUNT });

    await expect(connect(MISTY_ACCOUNT, service, MISTY)).resolves.toMatchObject({ outcome: 'added' });
    expect(rows().map((r) => r.professor_player_id)).toEqual([null, MISTY_ACCOUNT.playerId]);
  });

  it('settles an owner and a professor connecting the same account at once with one row', async () => {
    const settled = await Promise.allSettled([connect(ASH, service, OWNER), connect(ASH, service, MISTY)]);
    expect(rows()).toHaveLength(1);
    const outcomes = settled.map((r) => (r.status === 'fulfilled' ? r.value.outcome : (r.reason as ConnectError).code)).sort();
    expect([['added', 'claimed'], ['added', 'connection_held']]).toContainEqual(outcomes);
  });

  it('lets only the holder disconnect a connection, the owner included', async () => {
    await leagueWithProfessors();

    for (const [actor, playerId] of [
      [OWNER, MISTY_ACCOUNT.playerId],
      [MISTY, ASH.playerId],
    ] as const) {
      const err = await rejection(service.disconnect(L, actor, playerId));
      expect(err).toBeInstanceOf(ConnectionAccessError);
      expect(err).toMatchObject({ code: 'not_your_connection', professorPlayerId: playerId });
    }
    expect(rows()).toHaveLength(2);
    await expect(service.disconnect(L, MISTY, MISTY_ACCOUNT.playerId)).resolves.toEqual({ revoked: true });
  });

  it("lets the owner change any display name, but only the holder change a full name", async () => {
    await leagueWithProfessors();

    expect(service.renameProfessor(L, OWNER, MISTY_ACCOUNT.playerId, { name: 'Misty W.' }).professorName).toBe('Misty W.');
    expect(() => service.renameProfessor(L, OWNER, MISTY_ACCOUNT.playerId, { fullName: 'Misty Waterflower' })).toThrow(
      expect.objectContaining({ code: 'not_your_connection' }),
    );
    expect(() => service.renameProfessor(L, MISTY, ASH.playerId, { name: 'Ash' })).toThrow(expect.objectContaining({ code: 'not_your_connection' }));
    expect(service.renameProfessor(L, MISTY, MISTY_ACCOUNT.playerId, { name: 'Misty', fullName: 'Misty Waterflower' })).toMatchObject({
      professorName: 'Misty',
      professorFullName: 'Misty Waterflower',
    });
  });

  it('shows the owner every connection, a member the league’s, and a professor outside the league only their own', async () => {
    await leagueWithProfessors();
    professors.get(GARY_ACCOUNT.sub)!.leagues = [OTHER_STORE];
    await connect(GARY_ACCOUNT, service, GARY);
    const ids = (viewer: Actor) => service.listConnections(L, viewer).map((c) => c.professorPlayerId).sort();

    expect(ids(OWNER)).toEqual([ASH.playerId, MISTY_ACCOUNT.playerId, GARY_ACCOUNT.playerId].sort());
    expect(ids(MISTY)).toEqual([ASH.playerId, MISTY_ACCOUNT.playerId].sort());
    expect(ids(GARY)).toEqual([GARY_ACCOUNT.playerId]);
  });
});

describe('connect attempts per user', () => {
  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
  const paste = (state: string) => `https://play-tools.pokemon.com/loggedIn?code=c&state=${state}`;

  it("keeps at most two in flight per user, dropping that user's oldest, never another user's", async () => {
    professors.set(MISTY_ACCOUNT.sub, { ...MISTY_ACCOUNT });
    const mistys = stateOf(service.startConnect(MISTY.userId).authorizeUrl);
    const first = stateOf(service.startConnect(OWNER.userId).authorizeUrl);
    const second = stateOf(service.startConnect(OWNER.userId).authorizeUrl);
    const third = stateOf(service.startConnect(OWNER.userId).authorizeUrl);

    expect(((await rejection(service.completeConnect(L, OWNER, paste(first)))) as ConnectError).code).toBe('unknown_attempt');
    oauth.subject = ASH.sub;
    await expect(service.completeConnect(L, OWNER, paste(second))).resolves.toMatchObject({ outcome: 'added' });
    oauth.subject = BROCK.sub;
    await expect(service.completeConnect(L, OWNER, paste(third))).resolves.toMatchObject({ outcome: 'added' });
    oauth.subject = MISTY_ACCOUNT.sub;
    await expect(service.completeConnect(L, MISTY, paste(mistys))).resolves.toMatchObject({ outcome: 'added' });
  });
});

describe('league membership (ADR-0015 §3)', () => {
  it('reads it at connect: member with that league’s permission, checked now', async () => {
    await connect(ASH);
    expect(membershipOf(ASH)).toEqual({ status: 'member', can_submit: 1, checked_at: clock.getTime() / 1000 });
  });

  it("is outside when a successful read lacks the league's group", async () => {
    await connect(ASH);
    await connect(BROCK);
    expect(membershipOf(BROCK)).toMatchObject({ status: 'outside', can_submit: 0 });
  });

  it('stays unknown and unchecked when the read at a connect fails, so the next keep-alive reads it again', async () => {
    await connect(ASH);
    professors.get(ASH.sub)!.leagues = new PokemonUpstreamError('unavailable', 'down');
    await connect(ASH);
    expect(membershipOf(ASH)).toEqual({ status: 'unknown', can_submit: 0, checked_at: null });
  });

  it('stays unknown while no league is chosen', async () => {
    professors.get(ASH.sub)!.leagues = [STORE, OTHER_STORE];
    await connect(ASH);
    advance(25 * HOUR);
    await service.keepAliveAll();
    expect(membershipOf(ASH)).toMatchObject({ status: 'unknown', checked_at: null });
  });

  it('reads every connection again, one at a time, when the owner changes the league; a failed read leaves only that one unknown', async () => {
    professors.get(ASH.sub)!.leagues = [STORE, OTHER_STORE];
    await connect(ASH);
    await service.selectLeague(L, OWNER, STORE.id);
    professors.get(BROCK.sub)!.leagues = [OTHER_STORE];
    await connect(BROCK);
    professors.set(MISTY_ACCOUNT.sub, { ...MISTY_ACCOUNT, leagues: [OTHER_STORE] });
    await connect(MISTY_ACCOUNT, service, MISTY);
    // The picker reads only the owner's connections; the professor's read is the one that fails.
    professors.get(MISTY_ACCOUNT.sub)!.leagues = new PokemonUpstreamError('rate_limited', 'slow down');
    leagueCalls = [];
    mostLeaguesInFlight = 0;

    const { unchecked } = await service.selectLeague(L, OWNER, OTHER_STORE.id);

    expect(unchecked).toBe(1);
    expect(membershipOf(ASH)).toMatchObject({ status: 'member' });
    expect(membershipOf(BROCK)).toMatchObject({ status: 'member' });
    expect(membershipOf(MISTY_ACCOUNT)).toMatchObject({ status: 'unknown', checked_at: null });
    // The picker's reads as the owner's two connections, then one read per connection.
    expect(leagueCalls).toEqual([ASH.playerId, BROCK.playerId, ASH.playerId, BROCK.playerId, MISTY_ACCOUNT.playerId]);
    expect(mostLeaguesInFlight).toBe(1);
  });

  describe('the keep-alive', () => {
    it('reads only connections last checked 24 hours ago or more', async () => {
      await connect(ASH);
      await connect(BROCK);
      database.sqlite.prepare('update league_membership set checked_at = ? where connection_id = ?').run(clock.getTime() / 1000 - 25 * 3600, idOf(ASH));
      database.sqlite.prepare('update league_membership set checked_at = ? where connection_id = ?').run(clock.getTime() / 1000 - 3600, idOf(BROCK));
      leagueCalls = [];

      await service.keepAliveAll();

      expect(leagueCalls).toEqual([ASH.playerId]);
      expect(membershipOf(ASH)!.checked_at).toBe(clock.getTime() / 1000);
    });

    it('reads a connection never checked', async () => {
      await connect(ASH);
      database.sqlite.prepare('update league_membership set checked_at = null').run();
      leagueCalls = [];
      await service.keepAliveAll();
      expect(leagueCalls).toEqual([ASH.playerId]);
    });

    it('keeps the state when the read fails', async () => {
      await connect(ASH);
      advance(25 * HOUR);
      professors.get(ASH.sub)!.leagues = new PokemonUpstreamError('unavailable', 'down');
      await service.keepAliveAll();
      expect(membershipOf(ASH)).toMatchObject({ status: 'member', can_submit: 1 });
    });

    it('marks a connection outside once a successful read lacks the league', async () => {
      await connect(ASH);
      advance(25 * HOUR);
      professors.get(ASH.sub)!.leagues = [OTHER_STORE];
      await service.keepAliveAll();
      expect(membershipOf(ASH)).toMatchObject({ status: 'outside', can_submit: 0 });
    });
  });
});

describe('actingConnection (the one place a professor becomes a connection for a write)', () => {
  it("answers the holder's connection", async () => {
    await leagueWithProfessors();
    expect(service.actingConnection(MISTY, MISTY_ACCOUNT.playerId, { kind: 'own' })).toEqual({ connectionId: idOf(MISTY_ACCOUNT) });
    expect(service.actingConnection(OWNER, ASH.playerId, { kind: 'own' })).toEqual({ connectionId: idOf(ASH) });
  });

  it("refuses anyone else, the owner included, naming the professor", async () => {
    await leagueWithProfessors();
    for (const [actor, playerId] of [
      [OWNER, MISTY_ACCOUNT.playerId],
      [MISTY, ASH.playerId],
      [GARY, MISTY_ACCOUNT.playerId],
    ] as const) {
      expect(() => service.actingConnection(actor, playerId, { kind: 'own' })).toThrow(
        expect.objectContaining({ name: 'ConnectionAccessError', code: 'not_your_connection', professorPlayerId: playerId }),
      );
    }
  });

  it('answers organizer_not_connected when nobody holds that player id', () => {
    expect(() => service.actingConnection(OWNER, '999', { kind: 'own' })).toThrow(
      expect.objectContaining({ code: 'organizer_not_connected', professorPlayerId: '999' }),
    );
  });

  it("answers needs_reconnect for the holder's connection that needs one, and not_your_connection to anyone else", async () => {
    await leagueWithProfessors();
    database.sqlite.prepare("update pokemon_connection set status = 'needs_reconnect'").run();
    expect(() => service.actingConnection(MISTY, MISTY_ACCOUNT.playerId, { kind: 'own' })).toThrow(expect.objectContaining({ code: 'needs_reconnect' }));
    expect(() => service.actingConnection(OWNER, MISTY_ACCOUNT.playerId, { kind: 'own' })).toThrow(expect.objectContaining({ code: 'not_your_connection' }));
  });
});

describe('readingConnection (attendance reads for a request)', () => {
  it("reads as the caller's own member connection first", async () => {
    await leagueWithProfessors();
    expect(service.readingConnection(L, MISTY)).toBe(idOf(MISTY_ACCOUNT));
    expect(service.readingConnection(L, OWNER)).toBe(idOf(ASH));
  });

  it('otherwise reads as any member, connected connection, lowest id first', async () => {
    await leagueWithProfessors();
    database.sqlite.prepare("update pokemon_connection set status = 'needs_reconnect' where id = ?").run(idOf(ASH));
    expect(service.readingConnection(L, OWNER)).toBe(idOf(MISTY_ACCOUNT));
    expect(service.readingConnection(L, null)).toBe(idOf(MISTY_ACCOUNT));
  });

  it('never reads as a connection outside the league or not yet confirmed in it', async () => {
    await connect(ASH);
    database.sqlite.prepare("update league_membership set status = 'unknown'").run();
    expect(() => service.readingConnection(L, OWNER)).toThrow(expect.objectContaining({ code: 'not_connected' }));
  });
});

describe("access (who may see the league's pages)", () => {
  it('lets the owner in with or without a connection', () => {
    expect(service.access(OWNER)).toEqual({ member: true, waiting: null });
  });

  it('keeps a professor waiting until their connection is confirmed in the league, saying why', async () => {
    expect(service.access(MISTY)).toEqual({ member: false, waiting: 'no_connection' });
    await leagueWithProfessors();
    expect(service.access(MISTY)).toEqual({ member: true, waiting: null });
    database.sqlite.prepare("update league_membership set status = 'unknown' where connection_id = ?").run(idOf(MISTY_ACCOUNT));
    expect(service.access(MISTY)).toEqual({ member: false, waiting: 'unknown' });
    database.sqlite.prepare("update league_membership set status = 'outside' where connection_id = ?").run(idOf(MISTY_ACCOUNT));
    expect(service.access(MISTY)).toEqual({ member: false, waiting: 'outside' });
  });
});

describe('listReadableConnections (reads across professors)', () => {
  it('leaves out connections outside the league, keeping unknown ones', async () => {
    await connect(ASH);
    await connect(BROCK);
    professors.set(MISTY_ACCOUNT.sub, { ...MISTY_ACCOUNT });
    await connect(MISTY_ACCOUNT, service, MISTY);
    database.sqlite.prepare("update league_membership set status = 'unknown' where connection_id = ?").run(idOf(MISTY_ACCOUNT));

    expect(service.listReadableConnections().map((c) => c.professorPlayerId)).toEqual([ASH.playerId, MISTY_ACCOUNT.playerId]);
  });
});

describe('every AAD the token vault sees binds a row (the kit refuses an empty one)', () => {
  interface VaultCall {
    op: 'encrypt' | 'decrypt';
    aad: string;
    threw: boolean;
  }

  /** Records each call's AAD before delegating to the real vault, so calls that throw are recorded too. */
  function recording(inner: StringVault, calls: VaultCall[]): StringVault {
    const record = <T>(op: VaultCall['op'], aad: string, run: () => T): T => {
      const call: VaultCall = { op, aad, threw: true };
      calls.push(call);
      const result = run();
      call.threw = false;
      return result;
    };
    return {
      encrypt: (plaintext, aad) => record('encrypt', aad, () => inner.encrypt(plaintext, aad)),
      decrypt: (blob, aad) => record('decrypt', aad, () => inner.decrypt(blob, aad)),
    };
  }

  const insertCarriedOver = (sub: string, ciphertext: Buffer) =>
    database.sqlite
      .prepare('insert into pokemon_connection (user_id, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at) values (1, ?, ?, ?, ?, ?)')
      .run(sub, ciphertext, 'connected', 1, 1).lastInsertRowid as number;

  it('across connect, refresh, reseal, disconnect and a replaced key, on the paths that throw too', async () => {
    const calls: VaultCall[] = [];
    const real = tokenVault(randomBytes(32).toString('base64'));
    vault = recording(real, calls);
    service = build();

    await connect(ASH); // seals the new connection's token
    advance(HOUR);
    await service.getAccessToken(idOf(ASH)); // opens it, seals the rotated one
    insertCarriedOver('sub-carried', real.encrypt('ory_rt_v1', L));
    insertCarriedOver('sub-foreign', tokenVault(randomBytes(32).toString('base64')).encrypt('ory_rt_x', L));
    expect(service.resealCarriedOver(L)).toBe(1); // tries its own row, then the league id; skips the foreign one
    await connect(BROCK);
    expect(await service.disconnect(L, OWNER, ASH.playerId)).toEqual({ revoked: true });

    vault = recording(tokenVault(randomBytes(32).toString('base64')), calls); // the key was replaced
    const restarted = build();
    expect(((await rejection(restarted.getAccessToken(idOf(BROCK)))) as PokemonUpstreamError).code).toBe('needs_reconnect');
    expect(await restarted.disconnect(L, OWNER, BROCK.playerId)).toEqual({ revoked: false });

    expect(calls.length).toBeGreaterThan(0);
    for (const { aad } of calls) expect(aad).toMatch(/^(pokemon_connection:[1-9]\d*|default)$/);
    expect(calls.filter((c) => c.aad === L && c.threw)).not.toEqual([]); // the foreign row under the league id
    expect(calls.filter((c) => c.aad === L && !c.threw)).not.toEqual([]); // the carried-over row under the league id
    expect(calls.filter((c) => c.aad.startsWith('pokemon_connection:') && c.threw)).not.toEqual([]);
    expect(calls.filter((c) => c.op === 'encrypt').map((c) => c.aad)).not.toContain(L);
  });
});
