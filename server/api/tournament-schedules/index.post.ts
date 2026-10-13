import { ScheduleBody } from '#shared/schemas/tournaments';

/** A schedule repeating a scaffold (ADR-0010 decision 3), planned on the next Upcoming read: 201. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const body = await readValidatedBody(event, ScheduleBody.parse);
  const schedule = tournamentsCall(() => useTournaments().createSchedule(leagueId, body));
  setResponseStatus(event, 201);
  return { schedule };
});
