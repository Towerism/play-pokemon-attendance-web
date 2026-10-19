export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  return { regulars: useMetrics().listRegulars(leagueId, leagueToday()) };
});
