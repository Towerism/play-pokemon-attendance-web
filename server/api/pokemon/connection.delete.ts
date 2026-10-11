/** Disconnect: revoke the refresh token at Pokémon (best effort) and forget it. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  return usePokemon().disconnect(leagueId);
});
