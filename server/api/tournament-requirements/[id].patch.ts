import { IdParam, RequirementPatch } from '#shared/schemas/tournaments';

/** Change a required event (turning it off included); 409 `requirement_exists` or `requirement_has_covers`. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  const patch = await readValidatedBody(event, RequirementPatch.parse);
  return { requirement: tournamentsCall(() => useTournaments().requirements.update(leagueId, id, patch)) };
});
