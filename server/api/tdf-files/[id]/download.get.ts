import { TdfFileIdParam } from '#shared/schemas/tdf-files';
import { attachmentDisposition } from '../../../modules/tdf-archive/disposition';

/**
 * Download an archived TDF, the only answer that carries a file's contents (ADR-0012 decision 5):
 * an attachment that is never cached, with one audit log line per download. A file the caller may not reach is a
 * 404 (ADR-0015 §4).
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, TdfFileIdParam.parse);
  const { filename, content } = (() => {
    try {
      assertTdfAccess(leagueId, actor, id, 'download');
      return useTdfArchive().read(leagueId, id);
    } catch (err) {
      throw tdfArchiveHttpError(err);
    }
  })();

  useLogger('tdf-archive').info(`TDF file ${id} downloaded`, { fileId: id, by: actor.username });
  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8');
  setResponseHeader(event, 'content-disposition', attachmentDisposition(filename));
  setResponseHeader(event, 'cache-control', 'no-store');
  return Buffer.from(content, 'utf8');
});
