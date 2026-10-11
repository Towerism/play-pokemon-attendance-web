import { createPlayToolsHttpAdapter } from '../modules/pokemon/adapters/play-tools/gateway';
import { createPtcOAuthClient } from '../modules/pokemon/adapters/ptc-oauth/client';
import { ConnectError, LeagueNotFoundError, type PokemonConnectionService, createPokemonConnectionService } from '../modules/pokemon/connection';
import { PokemonUpstreamError } from '../modules/pokemon/ports/errors';
import { createTokenVault } from '../modules/pokemon/vault/vault';

let pokemon: PokemonConnectionService | undefined;

/** The Pokémon connection (TokenProvider, connect flow, league discovery). */
export function usePokemon(): PokemonConnectionService {
  if (!pokemon) {
    const config = useRuntimeConfig();
    pokemon = createPokemonConnectionService({
      db: useDb(),
      vault: createTokenVault(config.tokenVaultKey),
      oauth: createPtcOAuthClient({ baseUrl: config.pokemon.accessUrl }),
      gateway: (tokens, leagueId) =>
        createPlayToolsHttpAdapter({ tokens, leagueId, baseUrl: config.pokemon.apiUrl, log: useLogger('pokemon') }),
      log: useLogger('pokemon'),
    });
  }
  return pokemon;
}

/** Maps pokemon-module errors to HTTP; `data.code` tells the UI what to show. Anything else is rethrown. */
export function pokemonHttpError(err: unknown): never {
  if (err instanceof ConnectError) throw createError({ statusCode: 400, message: err.message, data: { code: err.code } });
  if (err instanceof LeagueNotFoundError) throw createError({ statusCode: 422, message: err.message, data: { code: 'unknown_league' } });
  if (err instanceof PokemonUpstreamError) {
    const statusCode =
      err.code === 'not_connected' || err.code === 'needs_reconnect' ? 409 : err.code === 'rate_limited' ? 503 : 502;
    throw createError({ statusCode, message: err.message, data: { code: err.code } });
  }
  throw err;
}
