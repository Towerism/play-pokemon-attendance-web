import { IdParam, ScaffoldPatch } from '#shared/schemas/tournaments';

/** Rename a scaffold or replace its slots; its schedules are replanned. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  const patch = await readValidatedBody(event, ScaffoldPatch.parse);
  return { scaffold: tournamentsCall(() => useTournaments().updateScaffold(leagueId, id, patch)) };
});
