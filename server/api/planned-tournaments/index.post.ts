import { PlannedBody } from '#shared/schemas/tournaments';

/** A one-off planned tournament from a template; 409 `already_planned` for an event already planned (#100). */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const body = await readValidatedBody(event, PlannedBody.parse);
  const planned = tournamentsCall(() => useTournaments().createPlanned(leagueId, body));
  setResponseStatus(event, 201);
  return { planned };
});
