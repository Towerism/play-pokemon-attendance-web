/**
 * Import players from play-tools (#35): reads the same tournaments as the
 * staff import and adds the players they list to the league, as a read-only
 * `player_import` job. No body. 202, then follow `/api/submissions/{id}/events`.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const started = await useSubmissions().importPlayers(leagueId, user.username).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
