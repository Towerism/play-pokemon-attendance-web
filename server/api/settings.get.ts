/** League settings kept by the app (the Pokémon league lives on `GET /pokemon/connection`). */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  return { thresholds: useMetrics().getThresholds(leagueId) };
});
