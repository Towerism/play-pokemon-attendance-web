import { EditTargetParam } from '#shared/schemas/tournaments';

/**
 * **Cancel…** (ADR-0010 decision 8): the confirm dialog for a play-tools tournament (`{id}` = a planned id or a guid),
 * from fresh reads as its organizer: what it is, how many players and staff it lists, whether it can be cancelled, and
 * what to type to confirm.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { id } = await getValidatedRouterParams(event, EditTargetParam.parse);
  return useTournaments().cancelling.preview(leagueId, id).catch(tournamentsHttpError);
});
