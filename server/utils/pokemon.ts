import { tokenVault } from '../bootstrap/vaults';
import { createPlayToolsHttpAdapter } from '../modules/pokemon/adapters/play-tools/gateway';
import { createPtcOAuthClient } from '../modules/pokemon/adapters/ptc-oauth/client';
import {
  ConnectError,
  type ConnectErrorCode,
  ConnectionAccessError,
  type ConnectionAccessCode,
  ConnectionNotFoundError,
  LeagueNotFoundError,
  type PokemonConnectionService,
  type ProfessorConnection,
  type UpstreamLeague,
  createPokemonConnectionService,
} from '../modules/pokemon/connection';
import { PokemonUpstreamError } from '../modules/pokemon/ports/errors';
import type { League } from '../modules/pokemon/ports/play-tools-gateway';

let pokemon: PokemonConnectionService | undefined;

/** The professors' Pokémon connections (TokenProvider, connect flow, league binding). */
export function usePokemon(): PokemonConnectionService {
  if (!pokemon) {
    const config = useRuntimeConfig();
    pokemon = createPokemonConnectionService({
      db: useDb(),
      vault: tokenVault(config.tokenVaultKey),
      oauth: createPtcOAuthClient({ baseUrl: config.pokemon.accessUrl }),
      gateway: (tokens, connectionId) =>
        createPlayToolsHttpAdapter({ tokens, connectionId, baseUrl: config.pokemon.apiUrl, log: useLogger('pokemon') }),
      accounts: {
        actor: (id) => useAccounts().actor(id),
        clearReverify: (id) => useAccounts().clearReverify(id),
        seatsUsed: () => useInvites().seatsUsed(),
        boundPlayerId: (id) => useInvites().boundPlayerId(id),
      },
      log: useLogger('pokemon'),
    });
  }
  return pokemon;
}

/**
 * The play-tools gateway as one professor's connection: attendance goes in as whoever submits (ADR-0015 §4), and
 * tournaments are read and staffed as their organizer (#75).
 */
export function connectionGateway(connectionId: number | null) {
  return createPlayToolsHttpAdapter({
    tokens: usePokemon(),
    connectionId,
    baseUrl: useRuntimeConfig().pokemon.apiUrl,
    log: useLogger('pokemon'),
  });
}

/** A connection as the API returns it: no internal id, no holder's user id, never a token. */
export function connectionJson({ id: _id, userId: _user, ...connection }: ProfessorConnection) {
  return connection;
}

/** The league's activity group as the API returns it (ADR-0015 §3): it names no connection. */
export function leagueJson(league: UpstreamLeague | null) {
  return league && { activityGroupId: league.id, displayName: league.name, displayId: league.displayId };
}

export function upstreamLeagueJson(league: League) {
  return { activityGroupId: league.id, displayName: league.name, displayId: league.displayId };
}

const CONNECT_STATUS: Record<ConnectErrorCode, number> = {
  invalid_url: 400,
  unknown_attempt: 400,
  expired: 400,
  code_rejected: 400,
  connection_limit: 409,
  connection_held: 409,
  one_connection_only: 409,
  invite_player_mismatch: 409,
  profile_unavailable: 502,
  upstream_unavailable: 502,
};

const ACCESS_STATUS: Record<ConnectionAccessCode, number> = {
  organizer_not_connected: 409,
  needs_reconnect: 409,
  not_your_connection: 403,
  reverify_required: 403,
};

/** Maps pokemon-module errors to HTTP; `data.code` tells the UI what to show. Anything else is rethrown. */
export function pokemonHttpError(err: unknown): never {
  if (err instanceof ConnectionAccessError) {
    throw createError({ statusCode: ACCESS_STATUS[err.code], message: err.message, data: { code: err.code, professorPlayerId: err.professorPlayerId } });
  }
  if (err instanceof ConnectError) throw createError({ statusCode: CONNECT_STATUS[err.code], message: err.message, data: { code: err.code } });
  if (err instanceof ConnectionNotFoundError) throw createError({ statusCode: 404, message: err.message, data: { code: 'connection_not_found' } });
  if (err instanceof LeagueNotFoundError) throw createError({ statusCode: 404, message: err.message, data: { code: 'league_not_found' } });
  if (err instanceof PokemonUpstreamError) {
    const statusCode =
      err.code === 'not_connected' || err.code === 'needs_reconnect' ? 409 : err.code === 'rate_limited' ? 503 : 502;
    throw createError({ statusCode, message: err.message, data: { code: err.code } });
  }
  throw err;
}
