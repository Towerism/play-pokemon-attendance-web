import { TdfUploadParams } from '#shared/schemas/tdf';
import { TdfFileDeletedError, UploadNotFoundError } from '../../../../../modules/sessions/tdf-import';

/** Import a previewed `.tdf`: players, session players and sightings. Committing again is a no-op. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { date, uploadId } = await getValidatedRouterParams(event, TdfUploadParams.parse);
  try {
    return useTdfImports().commit(leagueId, date, uploadId);
  } catch (err) {
    if (err instanceof UploadNotFoundError) throw createError({ statusCode: 404, message: err.message });
    if (err instanceof TdfFileDeletedError) throw createError({ statusCode: 409, message: err.message, data: { code: 'tdf_file_deleted' } });
    throw tdfArchiveHttpError(err);
  }
});
