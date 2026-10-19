/** The live leases the caller granted or holds (the owner: all), and who the caller could lend to (ADR-0015 §5). */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  return useLeases().list(leagueId, actor);
});
