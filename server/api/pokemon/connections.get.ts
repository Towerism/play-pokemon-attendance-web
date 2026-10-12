/** Every professor's connection, and which one submits for the league. Answers from the database only; never a token. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const pokemon = usePokemon();
  return { connections: pokemon.listConnections(leagueId).map(connectionJson), league: leagueBindingJson(pokemon.getStatus(leagueId)) };
});
