import { messageVault } from '../bootstrap/vaults';
import { type MessagingService, createMessagingService } from '../modules/messaging/channel';
import { MessagingError, type MessagingErrorCode } from '../modules/messaging/errors';
import { DEFAULT_LEAGUE_ID } from '../modules/leagues';

let messaging: MessagingService | undefined;

/** The Discord channel Tournament Genie long-polls (ADR-0015 §7), with the message vault's own key. */
export function useMessaging(): MessagingService {
  messaging ??= createMessagingService({
    db: useDb(),
    vault: messageVault(useRuntimeConfig().messageVaultKey),
    leagueId: DEFAULT_LEAGUE_ID,
    log: useLogger('messaging'),
  });
  return messaging;
}

const STATUS: Record<MessagingErrorCode, number> = {
  genie_unavailable: 503,
  message_not_found: 404,
  shutting_down: 503,
};

/** Maps messaging errors to HTTP with `data.code`; anything else is rethrown. */
export function messagingHttpError(err: unknown): never {
  if (err instanceof MessagingError) throw createError({ statusCode: STATUS[err.code], message: err.message, data: { code: err.code } });
  throw err;
}
