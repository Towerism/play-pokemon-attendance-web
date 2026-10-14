import type { H3Event } from 'h3';
import { enforceRateLimit } from '@towerism/selfhost-kit/nitro';
import { type RateLimits, buildRateLimits } from '../bootstrap/rate-limits';

let limits: RateLimits | undefined;

/**
 * The login, setup and integration limiters and the trusted proxies (architecture §9), built once.
 * `server/plugins/0.rate-limits.ts` calls this at boot, so a setting the kit refuses fails startup.
 */
export function useRateLimits(): RateLimits {
  limits ??= buildRateLimits(useRuntimeConfig());
  return limits;
}

/**
 * Login and first-run setup are rate-limited per client (architecture §9).
 * Called first in the handler, before the body is read, so a limited request
 * costs no scrypt work. The client is the TCP peer, or the X-Forwarded-For
 * entry a trusted proxy (`NUXT_TRUSTED_PROXIES`, e.g. Caddy) appended. The
 * guard is the kit's `enforceRateLimit`.
 */
export function enforceAuthRateLimit(event: H3Event, route: 'login' | 'setup'): void {
  const { auth, trusted } = useRateLimits();
  enforceRateLimit(event, { limiter: auth[route], trusted });
}
