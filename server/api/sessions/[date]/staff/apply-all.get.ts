import { SessionDateParam } from '#shared/schemas/sessions';

/** The date's running staff batch (#76), so a reloaded page can follow it; 204 when none runs. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  try {
    const batch = useSubmissions().runningStaffBatch(leagueId, date);
    if (batch) return batch;
  } catch (err) {
    return submissionHttpError(err);
  }
  setResponseStatus(event, 204);
  return null;
});
