import { ProfessorNameBody, ProfessorParams } from '#shared/schemas/pokemon';

/** Set or clear a professor's display name (ADR-0008). Display only: it never goes to Pokémon. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { playerId } = await getValidatedRouterParams(event, ProfessorParams.parse);
  const { name } = await readValidatedBody(event, ProfessorNameBody.parse);
  try {
    return connectionJson(usePokemon().setProfessorName(leagueId, playerId, name));
  } catch (err) {
    pokemonHttpError(err);
  }
});
