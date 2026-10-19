import { IdParam } from '#shared/schemas/tournaments';

/** Archive a schedule: its rows not in play-tools go; ones in play-tools stay, never cancelled. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  tournamentsCall(() => useTournaments().archiveSchedule(leagueId, id));
  setResponseStatus(event, 204);
  return null;
});
