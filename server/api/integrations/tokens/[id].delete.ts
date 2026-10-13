import { IntegrationTokenIdParam } from '#shared/schemas/integrations';

/** Revoke an integration token: its secret stops working at once. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { id } = await getValidatedRouterParams(event, IntegrationTokenIdParam.parse);
  try {
    useIntegrationTokens().revoke(leagueId, id);
  } catch (err) {
    integrationsHttpError(err);
  }
  setResponseStatus(event, 204);
  return null;
});
