import { GrantLeasesBody } from '#shared/schemas/leases';

/** Lend one or more tournaments to one league member, all or none (ADR-0015 §5). */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const body = await readValidatedBody(event, GrantLeasesBody.parse);
  const granted = await useLeases().grant(leagueId, actor, body).catch(leasesHttpError);
  setResponseStatus(event, 201);
  return granted;
});
