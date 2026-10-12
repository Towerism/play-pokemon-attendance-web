import { ProfessorQuery } from '#shared/schemas/pokemon';

/** The leagues every connected professor shares (#75), as this professor names them; who was left out; and which one this league submits to when they are its submitting professor. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { professor } = await getValidatedQuery(event, ProfessorQuery.parse);
  const { leagues, selectedId, excluded } = await usePokemon().listUpstreamLeagues(leagueId, professor).catch(pokemonHttpError);
  return { leagues: leagues.map(upstreamLeagueJson), selectedId, excluded };
});
