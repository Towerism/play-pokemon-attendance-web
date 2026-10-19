import { TdfFileIdParam } from '#shared/schemas/tdf-files';

/** Delete an archived TDF at once; the rows that used it keep their SHA-256 and show "file deleted" (ADR-0012). */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, TdfFileIdParam.parse);
  try {
    return { deleted: true, ...useTdfArchive().delete(leagueId, id) };
  } catch (err) {
    throw tdfArchiveHttpError(err);
  }
});
