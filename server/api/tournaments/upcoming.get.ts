import { UpcomingQuery } from '#shared/schemas/tournaments';

/**
 * Plans every schedule, then lists planned and play-tools tournaments by date (ADR-0010 decisions 4 and 10), each with
 * any live lease, added after the listing cache (ADR-0015 §5).
 */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const range = await getValidatedQuery(event, UpcomingQuery.parse);
  const upcoming = await useTournaments().upcoming(leagueId, range).catch(tournamentsHttpError);
  return { ...upcoming, tournaments: withCardLeases(upcoming.tournaments) };
});
