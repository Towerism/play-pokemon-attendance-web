import { CreateIntegrationTokenBody } from '#shared/schemas/integrations';

/** Mint an integration token: 201 with its secret, the only time it is ever returned. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { label } = await readValidatedBody(event, CreateIntegrationTokenBody.parse);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  try {
    const created = useIntegrationTokens().create(leagueId, label, user.username);
    setResponseStatus(event, 201);
    return created;
  } catch (err) {
    integrationsHttpError(err);
  }
});
