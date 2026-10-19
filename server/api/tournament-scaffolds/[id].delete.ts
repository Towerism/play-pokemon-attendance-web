import { IdParam } from '#shared/schemas/tournaments';

/** Archive a scaffold; 409 `scaffold_in_use` while a schedule uses it. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  tournamentsCall(() => useTournaments().archiveScaffold(leagueId, id));
  setResponseStatus(event, 204);
  return null;
});
