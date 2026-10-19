import { EditTargetParam } from '#shared/schemas/tournaments';

/**
 * **Edit…** (ADR-0010 decision 11): the form for a planned tournament (`{id}` = its id) or a play-tools one (`{id}` =
 * its guid), from its resolved settings or a fresh read as its organizer, with read-only fields and the reschedule window.
 */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, EditTargetParam.parse);
  return useTournaments().editForm(leagueId, id).catch(tournamentsHttpError);
});
