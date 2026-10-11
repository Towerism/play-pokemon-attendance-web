import type { H3Event } from 'h3';
import { type TrustedProxies, clientKey, parseTrustedProxies } from '../modules/security/client-address';
import { type FixedWindowLimiter, createFixedWindowLimiter } from '../modules/security/rate-limit';

type AuthRoute = 'login' | 'setup';

let limiters: Record<AuthRoute, FixedWindowLimiter> | undefined;
let trusted: TrustedProxies | undefined;

/**
 * Login and first-run setup are rate-limited per client (architecture §9).
 * Called first in the handler, before the body is read, so a limited request
 * costs no scrypt work. The client is the TCP peer, or the X-Forwarded-For
 * entry a trusted proxy (`NUXT_TRUSTED_PROXIES`, e.g. Caddy) appended.
 */
export function enforceAuthRateLimit(event: H3Event, route: AuthRoute): void {
  const config = useRuntimeConfig(event);
  limiters ??= {
    login: createFixedWindowLimiter(config.authRateLimit.login),
    setup: createFixedWindowLimiter(config.authRateLimit.setup),
  };
  trusted ??= parseTrustedProxies(String(config.trustedProxies ?? ''));

  const key = clientKey({
    remoteAddress: event.node.req.socket?.remoteAddress,
    xForwardedFor: getRequestHeader(event, 'x-forwarded-for'),
    trusted,
  });
  const result = limiters[route].hit(key);
  if (result.allowed) return;

  const { retryAfterSeconds } = result;
  setResponseHeader(event, 'Retry-After', retryAfterSeconds);
  throw createError({
    statusCode: 429,
    statusMessage: 'Too Many Requests',
    message: `Too many attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
    data: { code: 'rate_limited', retryAfterSeconds },
  });
}
