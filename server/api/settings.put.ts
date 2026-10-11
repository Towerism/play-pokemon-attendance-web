import { SettingsBody, type Thresholds } from '#shared/schemas/settings';
import type { ConnectionView } from '../modules/pokemon/connection';

/** League settings: which upstream league (activity group) attendance goes to, and the curation thresholds. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { activityGroupId, thresholds } = await readValidatedBody(event, SettingsBody.parse);
  const result: { connection?: ConnectionView; thresholds?: Thresholds } = {};
  if (activityGroupId !== undefined) {
    result.connection = await usePokemon().selectLeague(leagueId, activityGroupId).catch(pokemonHttpError);
  }
  if (thresholds) result.thresholds = useMetrics().setThresholds(leagueId, thresholds);
  return result;
});
