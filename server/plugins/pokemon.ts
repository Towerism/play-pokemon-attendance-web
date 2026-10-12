import { DEFAULT_LEAGUE_ID } from '../modules/leagues';

/**
 * Boot, after the `database` plugin migrated (ADR-0008): a connection carried
 * over from v1 still has its token sealed with the league id. Re-seal it under
 * its own row before anything can refresh it, then refresh it in the
 * background so it learns which professor it belongs to.
 */
export default defineNitroPlugin(() => {
  const pokemon = usePokemon();
  const resealed = pokemon.resealCarriedOver(DEFAULT_LEAGUE_ID);
  if (resealed > 0) useLogger('pokemon').info(`Moved ${resealed} Pokémon connection(s) to per-professor storage.`, { resealed });
  void pokemon.identifyCarriedOver();
});
