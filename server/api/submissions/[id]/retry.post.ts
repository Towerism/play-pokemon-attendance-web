import { SubmissionIdParam } from '#shared/schemas/submission';

/** Retry (after `partial`/`failed`) or resume (after `interrupted`): a new attempt that plans again. 202. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { id } = await getValidatedRouterParams(event, SubmissionIdParam.parse);
  const started = await useSubmissions().retry(leagueId, id, user.username).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
