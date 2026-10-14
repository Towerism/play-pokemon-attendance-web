import { RequirementBody } from '#shared/schemas/tournaments';

/** A required event: 201; 409 `requirement_exists`, 422 `too_many_requirements`. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const body = await readValidatedBody(event, RequirementBody.parse);
  const requirement = tournamentsCall(() => useTournaments().requirements.create(leagueId, body));
  setResponseStatus(event, 201);
  return { requirement };
});
