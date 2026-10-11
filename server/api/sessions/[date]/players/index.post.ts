import { PlayerInput } from '#shared/schemas/roster';
import { SessionDateParam } from '#shared/schemas/sessions';
import { AlreadyRegularError } from '../../../../modules/sessions/service';

/** Add a session player by hand: 201 when added, 200 when already listed, 409 for a regular. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const body = await readValidatedBody(event, PlayerInput.parse);
  try {
    const { added, player } = useSessions().addPlayer(leagueId, date, body);
    setResponseStatus(event, added ? 201 : 200);
    return { player };
  } catch (err) {
    if (err instanceof AlreadyRegularError) throw createError({ statusCode: 409, message: err.message });
    throw err;
  }
});
