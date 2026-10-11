import { TdfUploadParams } from '#shared/schemas/tdf';
import { UploadNotFoundError } from '../../../../../modules/sessions/tdf-import';

/** Import a previewed `.tdf`: players, session players and sightings. Committing again is a no-op. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { date, uploadId } = await getValidatedRouterParams(event, TdfUploadParams.parse);
  try {
    return useTdfImports().commit(leagueId, date, uploadId);
  } catch (err) {
    if (err instanceof UploadNotFoundError) throw createError({ statusCode: 404, message: err.message });
    throw err;
  }
});
