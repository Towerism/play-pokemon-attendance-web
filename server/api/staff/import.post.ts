/**
 * Import staff from play-tools (ADR-0007 decision 5): reads every tournament
 * the account organizes into the staff list, as a read-only `staff_import`
 * job. No body. 202, then follow `/api/submissions/{id}/events`.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const started = await useSubmissions().importStaff(leagueId, user.username).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
