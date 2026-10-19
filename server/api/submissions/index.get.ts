import { SubmissionListQuery } from '#shared/schemas/submission';

/** Submission history, newest first, optionally for one date. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { date } = await getValidatedQuery(event, SubmissionListQuery.parse);
  return { submissions: useSubmissions().list(leagueId, { date }) };
});
