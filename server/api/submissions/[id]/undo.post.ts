import { SubmissionIdParam } from '#shared/schemas/submission';

/** Removes the records this submission added, as a new undo attempt in the background. 202. */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, SubmissionIdParam.parse);
  const started = await useSubmissions().undo(leagueId, id, actor).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
