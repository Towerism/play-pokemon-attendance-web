import { SessionDateParam } from '#shared/schemas/sessions';

/** The draft for a date: session players, regulars, resolved play session. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  return useSessions().getSession(leagueId, date);
});
