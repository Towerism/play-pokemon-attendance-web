export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  return { regulars: useRoster().listRegulars(leagueId) };
});
