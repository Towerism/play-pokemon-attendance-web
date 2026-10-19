import { DEFAULT_LEAGUE_ID } from '../../modules/leagues';

/**
 * The Pokémon connections the caller may see (ADR-0015 §3): the owner every one, a league member every one not
 * outside the league, anyone else only their own. And the league's activity group, which names no connection.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  const pokemon = usePokemon();
  return { connections: pokemon.listConnections(DEFAULT_LEAGUE_ID, actor).map(connectionJson), league: leagueJson(pokemon.league(DEFAULT_LEAGUE_ID)) };
});
