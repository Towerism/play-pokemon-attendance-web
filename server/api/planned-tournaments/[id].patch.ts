import { IdParam, PlannedPatch } from '#shared/schemas/tournaments';

/**
 * Skip, unskip, move or pick the series of a planned tournament not in play-tools; or skip and unskip one whose create
 * may have landed (#125). Nothing goes upstream.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  const patch = await readValidatedBody(event, PlannedPatch.parse);
  return tournamentsCall(() => useTournaments().updatePlanned(leagueId, id, patch));
});
