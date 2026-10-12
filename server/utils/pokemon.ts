import { createPlayToolsHttpAdapter } from '../modules/pokemon/adapters/play-tools/gateway';
import { createPtcOAuthClient } from '../modules/pokemon/adapters/ptc-oauth/client';
import {
  ConnectError,
  type ConnectErrorCode,
  ConnectionNotFoundError,
  type ConnectionView,
  LeagueNotFoundError,
  type PokemonConnectionService,
  type ProfessorConnection,
  createPokemonConnectionService,
} from '../modules/pokemon/connection';
import { PokemonUpstreamError } from '../modules/pokemon/ports/errors';
import type { League } from '../modules/pokemon/ports/play-tools-gateway';
import { createTokenVault } from '../modules/pokemon/vault/vault';

let pokemon: PokemonConnectionService | undefined;

/** The professors' Pokémon connections (TokenProvider, connect flow, league binding). */
export function usePokemon(): PokemonConnectionService {
  if (!pokemon) {
    const config = useRuntimeConfig();
    pokemon = createPokemonConnectionService({
      db: useDb(),
      vault: createTokenVault(config.tokenVaultKey),
      oauth: createPtcOAuthClient({ baseUrl: config.pokemon.accessUrl }),
      gateway: (tokens, connectionId) =>
        createPlayToolsHttpAdapter({ tokens, connectionId, baseUrl: config.pokemon.apiUrl, log: useLogger('pokemon') }),
      log: useLogger('pokemon'),
    });
  }
  return pokemon;
}

/** The play-tools gateway as the league's submitting professor; every call fails `not_connected` while none is chosen. */
export function leagueGateway(leagueId: string) {
  return createPlayToolsHttpAdapter({
    tokens: usePokemon(),
    connectionId: usePokemon().getStatus(leagueId).connectionId,
    baseUrl: useRuntimeConfig().pokemon.apiUrl,
    log: useLogger('pokemon'),
  });
}

/** A connection as the API returns it: no internal id, never a token. */
export function connectionJson({ id: _id, ...connection }: ProfessorConnection) {
  return connection;
}

/** The league's binding as the API returns it: who submits for it, and where to. */
export function leagueBindingJson(view: ConnectionView) {
  if (!view.league) return null;
  return {
    professorPlayerId: view.professor?.playerId ?? null,
    activityGroupId: view.league.id,
    displayName: view.league.name,
    displayId: view.league.displayId,
    canSubmit: view.league.canSubmit,
  };
}

export function upstreamLeagueJson(league: League) {
  return { activityGroupId: league.id, displayName: league.name, displayId: league.displayId, canSubmit: league.canSubmit };
}

const CONNECT_STATUS: Record<ConnectErrorCode, number> = {
  invalid_url: 400,
  unknown_attempt: 400,
  expired: 400,
  code_rejected: 400,
  connection_limit: 409,
  profile_unavailable: 502,
  upstream_unavailable: 502,
};

/** Maps pokemon-module errors to HTTP; `data.code` tells the UI what to show. Anything else is rethrown. */
export function pokemonHttpError(err: unknown): never {
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
