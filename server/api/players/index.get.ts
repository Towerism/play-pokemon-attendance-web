import { PlayersQuery } from '#shared/schemas/roster';

/** Players with curation metrics: everyone, promotion candidates, or stale regulars (architecture §5). */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { filter, q } = await getValidatedQuery(event, PlayersQuery.parse);
  const metrics = useMetrics();
  return {
    players: metrics.listPlayers(leagueId, { filter, q, today: leagueToday() }),
    thresholds: metrics.getThresholds(leagueId),
  };
});
