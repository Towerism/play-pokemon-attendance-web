/** The league's required events, on and off, by id; the organizer's six are seeded on first use. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  return { requirements: tournamentsCall(() => useTournaments().requirements.list(leagueId)) };
});
