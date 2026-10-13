import { IdParam } from '#shared/schemas/tournaments';

/** Archive a template (never deleted); 409 `template_in_use` while a scaffold uses it. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  tournamentsCall(() => useTournaments().archiveTemplate(leagueId, id));
  setResponseStatus(event, 204);
  return null;
});
