/** The roles play-tools offers staff, judge first; never `organizer`. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  return { roles: useStaffing().listRoles(leagueId) };
});
