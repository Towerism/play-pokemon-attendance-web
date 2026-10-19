import { SessionDateParam } from '#shared/schemas/sessions';
import { AddStaffBody } from '#shared/schemas/staffing';

/** Want a staffer on one of the date's tournaments: 201 when added, 200 when already wanted in that role. */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const body = await readValidatedBody(event, AddStaffBody.parse);
  const { created, assignment } = await useStaffing().addAssignment(leagueId, date, body, actor).catch(staffingHttpError);
  setResponseStatus(event, created ? 201 : 200);
  return { assignment };
});
