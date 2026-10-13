import { TemplateListQuery } from '#shared/schemas/tournaments';

/** The league's scaffolds and their slots; archived ones with `?archived=1`. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { archived } = await getValidatedQuery(event, TemplateListQuery.parse);
  return { scaffolds: useTournaments().listScaffolds(leagueId, { archived: archived === '1' }) };
});
