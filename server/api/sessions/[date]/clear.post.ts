import { SessionDateParam } from '#shared/schemas/sessions';
import { ClearSessionBody } from '#shared/schemas/submission';

/**
 * Clear session (danger zone): deletes every player record in the play
 * session. The organizer must type the date. 202, then follow
 * `/api/submissions/{id}/events`.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const { playSessionId, confirmDate } = await readValidatedBody(event, ClearSessionBody.parse);
  assertClearConfirmed(date, confirmDate);
  const started = await useSubmissions().clear(leagueId, date, playSessionId, user.username).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
