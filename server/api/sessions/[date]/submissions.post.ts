import { SessionDateParam } from '#shared/schemas/sessions';
import { StartSubmissionBody } from '#shared/schemas/submission';

/** Starts the submission job for the confirmed play session: 202, then follow `/api/submissions/{id}/events`. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const { playSessionId } = await readValidatedBody(event, StartSubmissionBody.parse);
  const started = await useSubmissions().start(leagueId, date, { playSessionId, startedBy: user.username }).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
