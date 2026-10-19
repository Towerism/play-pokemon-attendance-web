import { IdParam, TemplatePatch } from '#shared/schemas/tournaments';

/** Change some of a template's fields. Tournaments not created yet take the change; existing ones don't. */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  const patch = await readValidatedBody(event, TemplatePatch.parse);
  return { template: tournamentsCall(() => useTournaments().updateTemplate(leagueId, id, patch, actor)) };
});
