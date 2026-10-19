import { ProfessorNamesBody, ProfessorParams } from '#shared/schemas/pokemon';
import { DEFAULT_LEAGUE_ID } from '../../../modules/leagues';

/**
 * Set or clear a professor's display name (ADR-0008; display only, it never goes to Pokémon; its holder or the owner)
 * and full name (ADR-0011 decision 8; written into a TDF only when the app replaces its organizer; its holder only,
 * ADR-0015 §2). A name left out stays as it is.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  const { playerId } = await getValidatedRouterParams(event, ProfessorParams.parse);
  const names = await readValidatedBody(event, ProfessorNamesBody.parse);
  try {
    return connectionJson(usePokemon().renameProfessor(DEFAULT_LEAGUE_ID, actor, playerId, names));
  } catch (err) {
    pokemonHttpError(err);
  }
});
