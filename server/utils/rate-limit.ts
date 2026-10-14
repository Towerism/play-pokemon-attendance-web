import type { H3Event } from 'h3';
import { type FixedWindowLimiter, type TrustedProxies, createFixedWindowLimiter, parseTrustedProxies } from '@towerism/selfhost-kit';
import { enforceRateLimit } from '@towerism/selfhost-kit/nitro';

type AuthRoute = 'login' | 'setup';

let limiters: Record<AuthRoute, FixedWindowLimiter> | undefined;
let trusted: TrustedProxies | undefined;

/**
 * Login and first-run setup are rate-limited per client (architecture §9).
 * Called first in the handler, before the body is read, so a limited request
 * costs no scrypt work. The client is the TCP peer, or the X-Forwarded-For
 * entry a trusted proxy (`NUXT_TRUSTED_PROXIES`, e.g. Caddy) appended. The
 * guard is the kit's `enforceRateLimit`.
 */
export function enforceAuthRateLimit(event: H3Event, route: AuthRoute): void {
  const config = useRuntimeConfig(event);
  limiters ??= {
    login: createFixedWindowLimiter(config.authRateLimit.login),
    setup: createFixedWindowLimiter(config.authRateLimit.setup),
  };
  trusted ??= parseTrustedProxies(String(config.trustedProxies ?? ''));
  enforceRateLimit(event, { limiter: limiters[route], trusted });
}
