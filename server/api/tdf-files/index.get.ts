import { TdfFilesQuery } from '#shared/schemas/tdf-files';

/** The league's archived TDF files, newest first: metadata only, never contents (ADR-0012). */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const filter = await getValidatedQuery(event, TdfFilesQuery.parse);
  return { files: useTdfArchive().list(leagueId, filter) };
});
