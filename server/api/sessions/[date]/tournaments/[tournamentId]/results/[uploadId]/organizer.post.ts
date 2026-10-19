import { ResultsOrganizerBody, ResultsUploadParams } from '#shared/schemas/results';

/**
 * The tournament organizer's full name, asked once when the file's organizer must be replaced (ADR-0011 decision 8):
 * saved on their Pokémon connection, then the preview corrects the file and runs its checks again.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { date, tournamentId, uploadId } = await getValidatedRouterParams(event, ResultsUploadParams.parse);
  const { fullName } = await readValidatedBody(event, ResultsOrganizerBody.parse);
  return useTournamentResults().setOrganizerName(leagueId, date, tournamentId, uploadId, fullName, actor).catch(resultsHttpError);
});
