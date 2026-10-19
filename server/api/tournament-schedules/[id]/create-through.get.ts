import { CreateThroughQuery, IdParam } from '#shared/schemas/tournaments';

/** **Create through date…**, previewed: what the schedule would create through the date, and what it leaves out. Creates nothing. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  const { date } = await getValidatedQuery(event, CreateThroughQuery.parse);
  return useTournaments().createThrough(leagueId, id, date).catch(tournamentsHttpError);
});
