import { SessionDateParam } from '#shared/schemas/sessions';
import { StartSubmissionBody } from '#shared/schemas/submission';

/**
 * Starts the submission job for the confirmed play session, as one of the caller's connections (`professorPlayerId`
 * when they have several that can submit, ADR-0015 §4): 202, then follow `/api/submissions/{id}/events`.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const { playSessionId, professorPlayerId } = await readValidatedBody(event, StartSubmissionBody.parse);
  const started = await useSubmissions().start(leagueId, date, { playSessionId, actor, ...(professorPlayerId && { professorPlayerId }) }).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
