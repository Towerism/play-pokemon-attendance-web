import { SubmissionIdParam } from '#shared/schemas/submission';

/** Removes the records this submission added, as a new undo attempt in the background. 202. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { id } = await getValidatedRouterParams(event, SubmissionIdParam.parse);
  const started = await useSubmissions().undo(leagueId, id, user.username).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
