import { RegularPresentBody, SessionPlayerParams } from '#shared/schemas/sessions';
import { NotARegularError } from '../../../../modules/sessions/service';

/** Ticks a regular "present" (or not) for the date: evidence for regulars who skip the tournament (ADR-0005). */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { date, playerId } = await getValidatedRouterParams(event, SessionPlayerParams.parse);
  const { present } = await readValidatedBody(event, RegularPresentBody.parse);
  try {
    return useSessions().setRegularPresent(leagueId, date, playerId, present);
  } catch (err) {
    if (err instanceof NotARegularError) throw createError({ statusCode: 404, message: err.message });
    throw err;
  }
});
