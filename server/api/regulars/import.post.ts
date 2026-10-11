import { RegularsImportBody } from '#shared/schemas/roster';

/** One-time import of the CLI's `regulars.json` (body: the file's JSON array, as is). */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const players = await readValidatedBody(event, RegularsImportBody.parse);
  return useRoster().importRegulars(leagueId, players);
});
