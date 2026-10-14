import { CoverParams } from '#shared/schemas/tournaments';

/** Removes the period's manual cover: 204; 404 when there is none. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { id, periodStart } = await getValidatedRouterParams(event, CoverParams.parse);
  tournamentsCall(() => useTournaments().requirements.deleteCover(leagueId, id, periodStart));
  setResponseStatus(event, 204);
  return null;
});
