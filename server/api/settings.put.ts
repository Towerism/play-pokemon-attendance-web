import { SettingsBody, type Thresholds } from '#shared/schemas/settings';

/**
 * League settings (owner only): the upstream league (activity group), chosen from the leagues of the owner's own
 * connections, after which every connection's membership is read again (`unchecked` counts the reads that failed);
 * and the curation thresholds.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireOwner(event);
  const { activityGroupId, thresholds } = await readValidatedBody(event, SettingsBody.parse);
  const result: { league?: NonNullable<ReturnType<typeof leagueJson>> & { unchecked: number }; thresholds?: Thresholds } = {};
  if (activityGroupId !== undefined) {
    const { league, unchecked } = await usePokemon().selectLeague(leagueId, actor, activityGroupId).catch(pokemonHttpError);
    result.league = { ...leagueJson(league)!, unchecked };
  }
  if (thresholds) result.thresholds = useMetrics().setThresholds(leagueId, thresholds);
  return result;
});
