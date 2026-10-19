import { PlayerIdParam, PlayerPatch } from '#shared/schemas/roster';
import { PlayerNotFoundError } from '../../modules/roster/service';

/** Rename, notes, or toggle regular. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { playerId } = await getValidatedRouterParams(event, PlayerIdParam.parse);
  const patch = await readValidatedBody(event, PlayerPatch.parse);
  try {
    return { player: useRoster().updatePlayer(leagueId, playerId, patch) };
  } catch (err) {
    if (err instanceof PlayerNotFoundError) throw createError({ statusCode: 404, message: err.message });
    throw err;
  }
});
