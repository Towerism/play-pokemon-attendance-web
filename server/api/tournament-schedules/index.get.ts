/** The league's schedules, with their scaffold's name. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  return { schedules: useTournaments().listSchedules(leagueId) };
});
