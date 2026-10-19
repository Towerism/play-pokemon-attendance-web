import { IdParam, SchedulePatch } from '#shared/schemas/tournaments';

/** Change a schedule's rule, dates, horizon or pause; rows not in play-tools are replanned (ADR-0010 decision 4). */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  const patch = await readValidatedBody(event, SchedulePatch.parse);
  return { schedule: tournamentsCall(() => useTournaments().updateSchedule(leagueId, id, patch)) };
});
