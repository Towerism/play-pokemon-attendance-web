import { StaffBatchIdParam } from '#shared/schemas/staffing';

/** One staff batch (#76): each tournament's status, its job once started, progress and counts. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { id } = await getValidatedRouterParams(event, StaffBatchIdParam.parse);
  try {
    return useSubmissions().staffBatch(leagueId, id);
  } catch (err) {
    return submissionHttpError(err);
  }
});
