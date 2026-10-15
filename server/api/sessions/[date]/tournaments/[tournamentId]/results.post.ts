import { ResultsParams, ResultsPreviewBody } from '#shared/schemas/results';
import { TDF_MAX_BODY_BYTES } from '#shared/schemas/tdf';

/**
 * Drop a `.tdf` on a tournament card (ADR-0011 decision 3): checks it locally against fresh reads of the tournament as
 * its organizer, fixes an empty id or a wrong organizer, and keeps it in the encrypted archive. Nothing is sent to
 * play-tools. Answers the warnings, their fingerprint, and the attendance preview of the same file.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { date, tournamentId } = await getValidatedRouterParams(event, ResultsParams.parse);

  // Refuse oversized bodies before reading them into memory.
  const length = Number(getRequestHeader(event, 'content-length'));
  if (!Number.isFinite(length) || length <= 0) throw createError({ statusCode: 411, message: 'Content-Length is required.' });
  if (length > TDF_MAX_BODY_BYTES) throw createError({ statusCode: 413, message: 'The file is over 2 MB.' });

  const body = await readValidatedBody(event, ResultsPreviewBody.parse);
  return useTournamentResults().preview(leagueId, date, tournamentId, { ...body, by: user.username }).catch(resultsHttpError);
});
