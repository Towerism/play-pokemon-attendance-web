import { SessionDateParam } from '#shared/schemas/sessions';
import { ApplyStaffBody } from '#shared/schemas/staffing';

/**
 * Assign staff in play-tools: applies one of the date's tournaments' staff
 * assignments as a `staff` job (ADR-0007). 202, then follow
 * `/api/submissions/{id}/events`.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const { tournamentId } = await readValidatedBody(event, ApplyStaffBody.parse);
  const started = await useSubmissions().applyStaff(leagueId, date, { tournamentId, actor }).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
