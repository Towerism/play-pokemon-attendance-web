import { type FixedWindowLimiter, type TrustedProxies, createFixedWindowLimiter, parseTrustedProxies } from '@towerism/selfhost-kit';

type Limit = { max: unknown; windowMs: unknown };

/** The runtime config the rate limits come from (`nuxt.config.ts`, overridden by `NUXT_*`/`NITRO_*` env). */
export interface RateLimitConfig {
  authRateLimit: { login: Limit; setup: Limit };
  integrationRateLimit: Limit;
  trustedProxies?: unknown;
}

export interface RateLimits {
  auth: Record<'login' | 'setup', FixedWindowLimiter>;
  integration: FixedWindowLimiter;
  trusted: TrustedProxies;
}

/**
 * Attendance's limiters and trusted proxies (architecture §9), built once at boot by
 * `server/plugins/0.rate-limits.ts`, so a value the kit refuses fails startup instead of making the
 * limited routes answer 500. The launcher already checks the `NUXT_*` variables; this also catches a
 * value that reaches runtime config another way (`NITRO_*` names, a JSON-object override, `pnpm dev`, a
 * `NUXT_*` value of 2^53 or more). The messages hold variable names and the kit's text, never a value.
 */
export function buildRateLimits(config: RateLimitConfig): RateLimits {
  const { login, setup } = config.authRateLimit;
  const integration = config.integrationRateLimit;
  return {
    auth: {
      // The auth limits reach the limiter as configured (a cast, not Number(): a JSON override's string such as
      // '{"max":"5"}' must keep failing, as since A1); the integration limit is coerced, as before.
      login: limiter('NUXT_AUTH_RATE_LIMIT_LOGIN', login as { max: number; windowMs: number }),
      setup: limiter('NUXT_AUTH_RATE_LIMIT_SETUP', setup as { max: number; windowMs: number }),
    },
    integration: limiter('NUXT_INTEGRATION_RATE_LIMIT', { max: Number(integration.max), windowMs: Number(integration.windowMs) }),
    // Its own error already starts with NUXT_TRUSTED_PROXIES and the bad entry.
    trusted: parseTrustedProxies(String(config.trustedProxies ?? '')),
  };
}

function limiter(prefix: string, options: { max: number; windowMs: number }): FixedWindowLimiter {
  try {
    return createFixedWindowLimiter(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid rate limit (${prefix}_MAX / ${prefix}_WINDOW_MS, or their NITRO_ or JSON-object override): ${message}`, {
      cause: err,
    });
  }
}
