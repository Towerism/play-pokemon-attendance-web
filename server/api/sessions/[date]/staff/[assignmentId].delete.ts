import { StaffAssignmentParams } from '#shared/schemas/staffing';

/** Remove a wanted staffer: gone at once, or (once in play-tools) left for the staff job to delete there. */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { date, assignmentId } = await getValidatedRouterParams(event, StaffAssignmentParams.parse);
  await useStaffing().removeAssignment(leagueId, date, assignmentId, actor).catch(staffingHttpError);
  setResponseStatus(event, 204);
  return null;
});
