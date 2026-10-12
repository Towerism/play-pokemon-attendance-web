import { SettingsBody, type Thresholds } from '#shared/schemas/settings';

/** League settings: which professor submits for it and to which upstream league (activity group), and the curation thresholds. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { professorPlayerId, activityGroupId, thresholds } = await readValidatedBody(event, SettingsBody.parse);
  const result: { connection?: ReturnType<typeof leagueBindingJson>; thresholds?: Thresholds } = {};
  if (professorPlayerId !== undefined && activityGroupId !== undefined) {
    result.connection = leagueBindingJson(await usePokemon().selectLeague(leagueId, professorPlayerId, activityGroupId).catch(pokemonHttpError));
  }
  if (thresholds) result.thresholds = useMetrics().setThresholds(leagueId, thresholds);
  return result;
});
