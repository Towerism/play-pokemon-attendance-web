/** The connected Pokémon account's leagues, and which one this league submits to. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  return usePokemon().listUpstreamLeagues(leagueId).catch(pokemonHttpError);
});
