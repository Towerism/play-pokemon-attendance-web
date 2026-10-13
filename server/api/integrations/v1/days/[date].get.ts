import { SessionDateParam } from '#shared/schemas/sessions';

/** A day's tournaments and staff for Tournament Genie (#115, ADR-0013): bearer token only, never a session. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');
  const token = requireIntegrationToken(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const day = await useIntegrationDays().day(token.leagueId, date).catch(integrationsHttpError);
  useIntegrationTokens().markUsed(token.id);
  const unread = day.professors.filter((p) => p.status === 'unread').map((p) => p.playerId);
  useLogger('integrations').info('integration day read', { tokenId: token.id, tokenLabel: token.label, date, tournaments: day.tournaments.length, unread });
  return day;
});
