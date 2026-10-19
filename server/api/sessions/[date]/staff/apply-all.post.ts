import { SessionDateParam } from '#shared/schemas/sessions';
import { ApplyAllStaffBody } from '#shared/schemas/staffing';

/**
 * Assign staff for every tournament at once (#76): one staff job per tournament, one after another, each as
 * its organizer (ADR-0007 update). 202, then follow `/api/staff-batches/{id}`.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const { tournamentIds } = await readValidatedBody(event, ApplyAllStaffBody.parse);
  const started = await useSubmissions().applyStaffAll(leagueId, date, { tournamentIds, actor }).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
