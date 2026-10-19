/**
 * The leagues the owner may choose from (ADR-0015 §3): those of the owner's own connections, each read as that
 * connection; which one is chosen; and the owner connections left out because they need a reconnect.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireOwner(event);
  const { leagues, selectedId, excluded } = await usePokemon().listUpstreamLeagues(leagueId, actor).catch(pokemonHttpError);
  return { leagues: leagues.map(upstreamLeagueJson), selectedId, excluded };
});
