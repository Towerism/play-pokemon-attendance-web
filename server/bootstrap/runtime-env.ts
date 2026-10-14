/**
 * Shim (A3, #131): the runtime env comes from `@towerism/selfhost-kit`'s `prepareRuntimeEnv`. Same export
 * names as before, with attendance's secrets and rate-limit variables configured here. Removed once the
 * launcher uses the kit directly.
 */
import { type PreparedEnv, prepareRuntimeEnv as prepareKitRuntimeEnv } from '@towerism/selfhost-kit';
import { SESSION_PASSWORD, TDF_VAULT_KEY, TOKEN_VAULT_KEY } from './secrets';

export { InvalidConfigError } from '@towerism/selfhost-kit';

/** Optional tuning for `runtimeConfig.authRateLimit` and `integrationRateLimit` (tests change them; never in the template). */
const RATE_LIMIT_VARS = [
  'NUXT_AUTH_RATE_LIMIT_LOGIN_MAX',
  'NUXT_AUTH_RATE_LIMIT_LOGIN_WINDOW_MS',
  'NUXT_AUTH_RATE_LIMIT_SETUP_MAX',
  'NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS',
  'NUXT_INTEGRATION_RATE_LIMIT_MAX',
  'NUXT_INTEGRATION_RATE_LIMIT_WINDOW_MS',
];

/**
 * Env for the Nitro server, worked out before it loads (Nitro reads runtime config from env once, at
 * import). Secrets live in `secrets/` next to the database, so everything persistent sits under one
 * volume (ADR-0006).
 */
export function prepareRuntimeEnv(input: Record<string, string | undefined>): PreparedEnv {
  return prepareKitRuntimeEnv(input, {
    secrets: [SESSION_PASSWORD, TOKEN_VAULT_KEY, TDF_VAULT_KEY],
    positiveIntegerVars: RATE_LIMIT_VARS,
  });
}
