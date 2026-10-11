import { PlayersQuery } from '#shared/schemas/roster';

/** Every player known in the league. Metrics and the promote/stale filters arrive in M6. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { q } = await getValidatedQuery(event, PlayersQuery.parse);
  return { players: useRoster().listPlayers(leagueId, { q }) };
});
