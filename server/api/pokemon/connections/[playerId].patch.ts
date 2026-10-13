import { ProfessorNamesBody, ProfessorParams } from '#shared/schemas/pokemon';

/**
 * Set or clear a professor's display name (ADR-0008; display only, it never goes to Pokémon) and full name (ADR-0011
 * decision 8; written into a TDF only when the app replaces its organizer). A name left out stays as it is.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { playerId } = await getValidatedRouterParams(event, ProfessorParams.parse);
  const names = await readValidatedBody(event, ProfessorNamesBody.parse);
  try {
    return connectionJson(usePokemon().renameProfessor(leagueId, playerId, names));
  } catch (err) {
    pokemonHttpError(err);
  }
});
