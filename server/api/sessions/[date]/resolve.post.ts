import { SessionDateParam } from '#shared/schemas/sessions';

/** Date → that local day's upstream play sessions, for the organizer to confirm (§4.4). */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  return usePlaySessionResolver().resolve(leagueId, date).catch(submissionHttpError);
});
