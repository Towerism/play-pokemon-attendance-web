/** Connection status for Settings and the reconnect banner. Never includes a token. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  return usePokemon().getStatus(leagueId);
});
