import { ProfessorQuery } from '#shared/schemas/pokemon';

/** One professor's leagues on play-tools, and which one this league submits to when they are its submitting professor. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { professor } = await getValidatedQuery(event, ProfessorQuery.parse);
  const { leagues, selectedId } = await usePokemon().listUpstreamLeagues(leagueId, professor).catch(pokemonHttpError);
  return { leagues: leagues.map(upstreamLeagueJson), selectedId };
});
