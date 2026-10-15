import { ResultsRemoveStaffBody, ResultsUploadParams } from '#shared/schemas/results';

/**
 * **Remove from staff** (ADR-0007 update, #101): checks each player is in the file, on the tournament's staff and not
 * its organizer, then a staff job as the organizer removes only them. 202, then follow `/api/submissions/{id}/events`.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { date, tournamentId, uploadId } = await getValidatedRouterParams(event, ResultsUploadParams.parse);
  const { playerIds } = await readValidatedBody(event, ResultsRemoveStaffBody.parse);
  const started = await useSubmissions()
    .removeResultsStaff(leagueId, { date, tournamentId, uploadId, playerIds, startedBy: user.username })
    .catch(resultsHttpError);
  setResponseStatus(event, 202);
  return started;
});
