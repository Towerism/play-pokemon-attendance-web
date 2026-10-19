import { MessagesQuery } from '#shared/schemas/integrations';

/**
 * The Discord channel's long poll for Tournament Genie (ADR-0015 §7): bearer token with `messages:deliver` only. Answers
 * as soon as a message can be handed out, or after `wait` seconds with none. A client that goes away frees its slot.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');
  const token = requireIntegrationToken(event, 'messages:deliver', 'messagePoll');
  const { wait, limit } = await getValidatedQuery(event, MessagesQuery.parse);
  const gone = new AbortController();
  // The response's `close` fires when it is sent, or when the client drops the connection first.
  event.node.res.once('close', () => gone.abort());
  const messages = await useMessaging()
    .poll(token.leagueId, token.id, { waitMs: wait * 1000, limit, signal: gone.signal })
    .catch(messagingHttpError);
  useIntegrationTokens().markUsed(token.id);
  return { messages };
});
