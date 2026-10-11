import { SettingsBody } from '#shared/schemas/pokemon';

/** League settings. M4: which upstream league (activity group) attendance goes to. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { activityGroupId } = await readValidatedBody(event, SettingsBody.parse);
  const connection = await usePokemon().selectLeague(leagueId, activityGroupId).catch(pokemonHttpError);
  return { connection };
});
