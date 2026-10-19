import { PlayerIdParam } from '#shared/schemas/roster';

/** Stop submitting a player every session; they stay on file as a known player. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { playerId } = await getValidatedRouterParams(event, PlayerIdParam.parse);
  if (!useRoster().removeRegular(leagueId, playerId)) {
    throw createError({ statusCode: 404, message: `Player ${playerId} is not a regular.` });
  }
  setResponseStatus(event, 204);
  return null;
});
