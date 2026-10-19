import { ScaffoldBody } from '#shared/schemas/tournaments';

/** A scaffold: templates held together, in slot order (ADR-0010 decision 3): 201. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const body = await readValidatedBody(event, ScaffoldBody.parse);
  const scaffold = tournamentsCall(() => useTournaments().createScaffold(leagueId, body));
  setResponseStatus(event, 201);
  return { scaffold };
});
