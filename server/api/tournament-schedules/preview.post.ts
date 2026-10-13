import { SchedulePreviewBody } from '#shared/schemas/tournaments';

/** The next dates a rule would plan, with each slot of a scaffold; nothing is saved. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const body = await readValidatedBody(event, SchedulePreviewBody.parse);
  return tournamentsCall(() => useTournaments().previewSchedule(leagueId, body));
});
