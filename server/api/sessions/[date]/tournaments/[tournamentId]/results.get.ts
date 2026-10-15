import { ResultsParams } from '#shared/schemas/results';

/**
 * A tournament card's Results section (ADR-0011 decision 1): play-tools' status from a fresh read as the organizer,
 * the latest upload and earlier attempts. An upload still processing is followed on this read (Update #96 D10).
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  await requireUserSession(event);
  const { date, tournamentId } = await getValidatedRouterParams(event, ResultsParams.parse);
  return useTournamentResults().section(leagueId, date, tournamentId).catch(resultsHttpError);
});
