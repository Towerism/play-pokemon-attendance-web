export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  return { regulars: useMetrics().listRegulars(leagueId, leagueToday()) };
});
