import { SubmissionIdParam } from '#shared/schemas/submission';

/** One submission with its per-player outcomes. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { id } = await getValidatedRouterParams(event, SubmissionIdParam.parse);
  try {
    return useSubmissions().get(leagueId, id);
  } catch (err) {
    return submissionHttpError(err);
  }
});
