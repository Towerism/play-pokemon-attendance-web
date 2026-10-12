import { ChangeStaffRoleBody, StaffAssignmentParams } from '#shared/schemas/staffing';

/** Change a wanted staffer's role; the staff job changes it in play-tools. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { date, assignmentId } = await getValidatedRouterParams(event, StaffAssignmentParams.parse);
  const { role } = await readValidatedBody(event, ChangeStaffRoleBody.parse);
  return { assignment: await useStaffing().changeRole(leagueId, date, assignmentId, role).catch(staffingHttpError) };
});
