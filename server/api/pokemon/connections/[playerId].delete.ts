import { ProfessorParams } from '#shared/schemas/pokemon';
import { DEFAULT_LEAGUE_ID } from '../../../modules/leagues';

/** Disconnect the caller's own Pokémon account: revoke its refresh token at Pokémon (best effort) and forget it. */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  const { playerId } = await getValidatedRouterParams(event, ProfessorParams.parse);
  return usePokemon().disconnect(DEFAULT_LEAGUE_ID, actor, playerId).catch(pokemonHttpError);
});
