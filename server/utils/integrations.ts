import type { H3Event } from 'h3';
import { parseBearer } from '../modules/integrations/bearer';
import { IntegrationError, type IntegrationErrorCode } from '../modules/integrations/errors';
import { type IntegrationDayService, createIntegrationDayService } from '../modules/integrations/service';
import { type AuthenticatedToken, type IntegrationTokenService, createIntegrationTokenService } from '../modules/integrations/tokens';
import { type FixedWindowLimiter, createFixedWindowLimiter } from '@towerism/selfhost-kit';

let tokens: IntegrationTokenService | undefined;
let days: IntegrationDayService | undefined;
let limiter: FixedWindowLimiter | undefined;

/** Integration tokens (#115, ADR-0013): minted in Settings, used by Tournament Genie. */
export function useIntegrationTokens(): IntegrationTokenService {
  tokens ??= createIntegrationTokenService({ db: useDb() });
  return tokens;
}

/** The v1 day an integration reads. */
export function useIntegrationDays(): IntegrationDayService {
  days ??= createIntegrationDayService({
    staffing: useStaffing(),
    connections: usePokemon(),
    timeZone: leagueTimeZone(),
    log: useLogger('integrations'),
  });
  return days;
}

/**
 * Authenticates an integrations request by its bearer token alone (a session cookie never counts), then applies
 * the per-token limit before anything is read. Every refusal of the token is the same 401, so a caller can't tell
 * a missing token from an unknown or revoked one.
 */
export function requireIntegrationToken(event: H3Event): AuthenticatedToken {
  const token = useIntegrationTokens().authenticate(parseBearer(getRequestHeader(event, 'authorization')) ?? undefined);
  if (!token) {
    setResponseHeader(event, 'WWW-Authenticate', 'Bearer realm="integrations", error="invalid_token"');
    throw createError({ statusCode: 401, message: 'A valid integration token is required.', data: { code: 'invalid_token' } });
  }
  const config = useRuntimeConfig(event).integrationRateLimit;
  limiter ??= createFixedWindowLimiter({ max: Number(config.max), windowMs: Number(config.windowMs) });
  const hit = limiter.hit(`token:${token.id}`);
  if (!hit.allowed) {
    setResponseHeader(event, 'Retry-After', hit.retryAfterSeconds);
    throw createError({
      statusCode: 429,
      statusMessage: 'Too Many Requests',
      message: `Too many requests for this integration token. Try again in ${hit.retryAfterSeconds} seconds.`,
      data: { code: 'rate_limited', retryAfterSeconds: hit.retryAfterSeconds },
    });
  }
  return token;
}

const STATUS: Record<IntegrationErrorCode, number> = {
  token_limit: 409,
  not_found: 404,
  professor_unidentified: 503,
};

/** Maps integration, staffing and Pokémon errors to HTTP with `data.code`. */
export function integrationsHttpError(err: unknown): never {
  if (err instanceof IntegrationError) {
    throw createError({ statusCode: STATUS[err.code], message: err.message, data: { code: err.code } });
  }
  return staffingHttpError(err);
}
