import { TournamentGuidParam } from '#shared/schemas/tournaments';
import { attachmentDisposition } from '../../../modules/tdf-archive/disposition';

/**
 * **Download TDF** (ADR-0012 decision 7, #97): the archived file of the tournament's latest confirmed results upload,
 * never fetched from play-tools (it answers 403, #107), so no connection or lease is needed. An attachment that is never
 * cached, with one audit log line per download.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { id } = await getValidatedRouterParams(event, TournamentGuidParam.parse);
  const { fileId, filename, content } = (() => {
    try {
      return useTournamentResults().download(leagueId, id);
    } catch (err) {
      return resultsHttpError(err);
    }
  })();

  useLogger('tournaments').info(`Tournament ${id} TDF downloaded`, { fileId, tournamentId: id, by: user.username });
  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8');
  setResponseHeader(event, 'content-disposition', attachmentDisposition(filename));
  setResponseHeader(event, 'cache-control', 'no-store');
  return Buffer.from(content, 'utf8');
});
