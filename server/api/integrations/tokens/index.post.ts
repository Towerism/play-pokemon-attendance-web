import { CreateIntegrationTokenBody } from '#shared/schemas/integrations';

/** Mint an integration token: 201 with its secret, the only time it is ever returned. */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireOwner(event);
  const { label, scopes } = await readValidatedBody(event, CreateIntegrationTokenBody.parse);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  try {
    const created = useIntegrationTokens().create(leagueId, label, actor.username, scopes);
    setResponseStatus(event, 201);
    return created;
  } catch (err) {
    integrationsHttpError(err);
  }
});
