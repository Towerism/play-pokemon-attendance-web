import { ProfessorParams } from '#shared/schemas/pokemon';

/** Disconnect one professor: revoke their refresh token at Pokémon (best effort) and forget it. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { playerId } = await getValidatedRouterParams(event, ProfessorParams.parse);
  return usePokemon().disconnect(leagueId, playerId).catch(pokemonHttpError);
});
