import { TdfFileIdParam } from '#shared/schemas/tdf-files';

/** Delete an archived TDF at once; the rows that used it keep their SHA-256 and show "file deleted" (ADR-0012). Only a file the caller may reach (ADR-0015 §4). */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, TdfFileIdParam.parse);
  try {
    assertTdfAccess(leagueId, actor, id);
    return { deleted: true, ...useTdfArchive().delete(leagueId, id) };
  } catch (err) {
    throw tdfArchiveHttpError(err);
  }
});
