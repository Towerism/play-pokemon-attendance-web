import { ResultsUploadParams } from '#shared/schemas/results';

/**
 * **Upload again…** (Update #96 D5): the preview's checks again from the archived file against a fresh read. An open
 * preview is updated in place; a finished attempt opens a new one. Nothing is sent.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { date, tournamentId, uploadId } = await getValidatedRouterParams(event, ResultsUploadParams.parse);
  return useTournamentResults().recheck(leagueId, date, tournamentId, uploadId, user.username).catch(resultsHttpError);
});
