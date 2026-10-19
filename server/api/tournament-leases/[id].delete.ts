import { LeaseIdParam } from '#shared/schemas/leases';

/** Ends a lease (its organizer) or gives it back (its lent professor), saying whether a notice went out (ADR-0015 §5). */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, LeaseIdParam.parse);
  try {
    return useLeases().end(leagueId, actor, id);
  } catch (err) {
    return leasesHttpError(err);
  }
});
