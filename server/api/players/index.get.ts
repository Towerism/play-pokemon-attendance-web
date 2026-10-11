import { PlayersQuery } from '#shared/schemas/roster';

/** Players with curation metrics: everyone, promotion candidates, or stale regulars (architecture §5); `limit` caps a search. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { filter, q, limit } = await getValidatedQuery(event, PlayersQuery.parse);
  const metrics = useMetrics();
  return {
    players: metrics.listPlayers(leagueId, { filter, q, limit, today: leagueToday() }),
    thresholds: metrics.getThresholds(leagueId),
  };
});
