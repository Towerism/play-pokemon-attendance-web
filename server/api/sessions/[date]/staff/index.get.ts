import { SessionDateParam } from '#shared/schemas/sessions';

/** The date's tournaments in this league, read live from play-tools, with their staff. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  return useStaffing().sessionStaff(leagueId, date).catch(staffingHttpError);
});
