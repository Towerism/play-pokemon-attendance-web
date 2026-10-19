import { SubmissionIdParam } from '#shared/schemas/submission';

/** One submission with its per-player outcomes. A results upload still processing is followed on this read (#96). */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, SubmissionIdParam.parse);
  try {
    await useSubmissions().followResults(leagueId, id);
    return useSubmissions().get(leagueId, id);
  } catch (err) {
    return submissionHttpError(err);
  }
});
