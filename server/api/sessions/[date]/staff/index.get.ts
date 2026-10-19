import { SessionDateParam } from '#shared/schemas/sessions';

/** The date's tournaments in this league, read live from play-tools, with their staff and any live lease (ADR-0015 §5). */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const view = await useStaffing().sessionStaff(leagueId, date).catch(staffingHttpError);
  return { ...view, tournaments: withCardLeases(view.tournaments) };
});
