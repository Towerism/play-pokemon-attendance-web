import { EditBody, EditTargetParam } from '#shared/schemas/tournaments';

/** **Edit…**, previewed: every tournament the change would touch, with before → after, in play-tools / planned / left out. Changes nothing. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { id } = await getValidatedRouterParams(event, EditTargetParam.parse);
  const body = await readValidatedBody(event, EditBody.parse);
  return useTournaments().editPreview(leagueId, id, body).catch(tournamentsHttpError);
});
