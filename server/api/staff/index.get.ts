import { StaffQuery } from '#shared/schemas/staffing';

/** The staff list: everyone who has staffed the league's tournaments, most recent first (ADR-0007). */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const query = await getValidatedQuery(event, StaffQuery.parse);
  return useStaffing().searchStaff(leagueId, query);
});
