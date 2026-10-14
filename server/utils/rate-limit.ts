import type { RateLimitOptions } from '@towerism/selfhost-kit/nitro';
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
 * The kit's `enforceRateLimit` options for login or first-run setup (architecture §9): their limiter and the
 * trusted proxies. The handler calls `enforceRateLimit(event, authRateLimit(route))` first, before the body is
 * read, so a limited request costs no scrypt work. The client is the TCP peer, or the X-Forwarded-For entry a
 * trusted proxy (`NUXT_TRUSTED_PROXIES`, e.g. Caddy) appended.
 */
export function authRateLimit(route: 'login' | 'setup'): RateLimitOptions {
  const { auth, trusted } = useRateLimits();
  return { limiter: auth[route], trusted };
}
