import { UpcomingQuery } from '#shared/schemas/tournaments';

/** Plans every schedule, then lists planned and play-tools tournaments by date (ADR-0010 decisions 4 and 10). */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const range = await getValidatedQuery(event, UpcomingQuery.parse);
  return useTournaments().upcoming(leagueId, range).catch(tournamentsHttpError);
});
