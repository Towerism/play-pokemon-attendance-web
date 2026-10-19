import { TournamentGuidParam } from '#shared/schemas/tournaments';
import { attachmentDisposition } from '../../../modules/tdf-archive/disposition';

/**
 * **Download TDF** (ADR-0012 decision 7, #97): the archived file of the tournament's latest confirmed results upload,
 * never fetched from play-tools (it answers 403, #107), so no connection is needed. A professor reaches it as the
 * stored-TDF rules say, a live lease on the tournament included (ADR-0015 §5). An attachment that is never
 * cached, with one audit log line per download.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, TournamentGuidParam.parse);
  const { fileId, filename, content } = (() => {
    try {
      const file = useTournamentResults().download(leagueId, id);
      assertTdfAccess(leagueId, actor, file.fileId, 'download');
      return file;
    } catch (err) {
      return resultsHttpError(err);
    }
  })();

  useLogger('tournaments').info(`Tournament ${id} TDF downloaded`, { fileId, tournamentId: id, by: actor.username });
  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8');
  setResponseHeader(event, 'content-disposition', attachmentDisposition(filename));
  setResponseHeader(event, 'cache-control', 'no-store');
  return Buffer.from(content, 'utf8');
});
