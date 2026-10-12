import { SessionDateParam } from '#shared/schemas/sessions';
import { ApplyAllStaffBody } from '#shared/schemas/staffing';

/**
 * Assign staff for every tournament at once (#76): one staff job per tournament, one after another, each as
 * its organizer (ADR-0007 update). 202, then follow `/api/staff-batches/{id}`.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const { tournamentIds } = await readValidatedBody(event, ApplyAllStaffBody.parse);
  const started = await useSubmissions().applyStaffAll(leagueId, date, { tournamentIds, startedBy: user.username }).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
