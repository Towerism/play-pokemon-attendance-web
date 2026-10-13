import { SessionDateParam } from '#shared/schemas/sessions';
import { TDF_MAX_BODY_BYTES, TdfUploadBody } from '#shared/schemas/tdf';
import { TdfError } from '#shared/tdf/parse';

/** Preview a `.tdf` for the date: who is new, known, a regular or already listed. Keeps the file in the encrypted archive; imports nothing. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);

  // Refuse oversized bodies before reading them into memory.
  const length = Number(getRequestHeader(event, 'content-length'));
  if (!Number.isFinite(length) || length <= 0) throw createError({ statusCode: 411, message: 'Content-Length is required.' });
  if (length > TDF_MAX_BODY_BYTES) throw createError({ statusCode: 413, message: 'The file is over 2 MB.' });

  const body = await readValidatedBody(event, TdfUploadBody.parse);
  try {
    return useTdfImports().preview(leagueId, date, { ...body, by: user.username });
  } catch (err) {
    if (err instanceof TdfError) {
      throw createError({ statusCode: err.code === 'too_large' ? 413 : 422, message: err.message, data: { code: err.code } });
    }
    throw err;
  }
});
