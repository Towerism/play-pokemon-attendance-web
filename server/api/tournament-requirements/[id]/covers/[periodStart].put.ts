import { CoverBody, CoverParams } from '#shared/schemas/tournaments';

/** **Mark as covered…**: records or replaces the period's manual cover; 400 `invalid_period`. */
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event);
  const leagueId = await requireLeague(event);
  const { id, periodStart } = await getValidatedRouterParams(event, CoverParams.parse);
  const body = await readValidatedBody(event, CoverBody.parse);
  return { cover: tournamentsCall(() => useTournaments().requirements.putCover(leagueId, id, periodStart, body, user.username)) };
});
