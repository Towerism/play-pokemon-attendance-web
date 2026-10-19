import { MessageIdParam, MessageResultBody } from '#shared/schemas/integrations';

/** Genie's delivery result for one message (ADR-0015 §7): 204, and a no-op for a message already final. */
export default defineEventHandler(async (event) => {
  const token = requireIntegrationToken(event, 'messages:deliver', 'messageResult');
  const { id } = await getValidatedRouterParams(event, MessageIdParam.parse);
  const result = await readValidatedBody(event, MessageResultBody.parse);
  try {
    useMessaging().report(token.leagueId, id, result);
  } catch (err) {
    messagingHttpError(err);
  }
  useIntegrationTokens().markUsed(token.id);
  setResponseStatus(event, 204);
  return null;
});
