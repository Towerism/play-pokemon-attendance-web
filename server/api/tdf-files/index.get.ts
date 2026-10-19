import { TdfFilesQuery } from '#shared/schemas/tdf-files';

/** The league's archived TDF files the caller may reach (ADR-0015 §4), newest first: metadata only, never contents (ADR-0012). */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const filter = await getValidatedQuery(event, TdfFilesQuery.parse);
  return { files: useTdfArchive().list(leagueId, filter).filter(tdfAccess(leagueId, actor)) };
});
