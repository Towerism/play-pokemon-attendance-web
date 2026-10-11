import { SessionPlayerParams } from '#shared/schemas/sessions';

export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { date, playerId } = await getValidatedRouterParams(event, SessionPlayerParams.parse);
  if (!useSessions().removePlayer(leagueId, date, playerId)) {
    throw createError({ statusCode: 404, message: `Player ${playerId} is not listed for ${date}.` });
  }
  setResponseStatus(event, 204);
  return null;
});
