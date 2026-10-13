import { TemplateListQuery } from '#shared/schemas/tournaments';

/** The league's tournament templates by name; archived ones with `?archived=1`. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { archived } = await getValidatedQuery(event, TemplateListQuery.parse);
  return { templates: useTournaments().listTemplates(leagueId, { archived: archived === '1' }) };
});
