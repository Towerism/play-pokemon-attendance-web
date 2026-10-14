/**
 * Attendance's configuration of the kit's secret bootstrap and runtime env (ADR-0014, A3). The mechanics
 * come from `@towerism/selfhost-kit`; this module only names attendance's secrets and checked variables.
 *
 * Shared by the launcher (`runLauncher` → `prepareRuntimeEnv(env, RUNTIME_ENV)`) and the log redactor
 * (`server/logging/app-logger.ts` hides `secretKeyNames(SECRETS)`). Plain TS with no side effects.
 *
 * The env names and file names are part of every install's `/data` contract (ADR-0006): never rename them.
 */
import { type SecretSpec, aes256Key, sessionPassword } from '@towerism/selfhost-kit';

/** In startup-log order. Secrets live in `secrets/` next to the database. */
export const SECRETS: readonly [SecretSpec, SecretSpec, SecretSpec] = [
  sessionPassword(),
  aes256Key({ env: 'NUXT_TOKEN_VAULT_KEY', file: 'token-vault.key', label: 'Token vault key' }),
  // The TDF archive's own key (ADR-0012): losing it loses the archive, not the Pokémon login.
  aes256Key({ env: 'NUXT_TDF_VAULT_KEY', file: 'tdf-vault.key', label: 'TDF vault key' }),
];

/** Optional tuning for `runtimeConfig.authRateLimit` and `integrationRateLimit` (tests change them; never in the template). */
export const POSITIVE_INTEGER_VARS: readonly string[] = [
  'NUXT_AUTH_RATE_LIMIT_LOGIN_MAX',
  'NUXT_AUTH_RATE_LIMIT_LOGIN_WINDOW_MS',
  'NUXT_AUTH_RATE_LIMIT_SETUP_MAX',
  'NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS',
  'NUXT_INTEGRATION_RATE_LIMIT_MAX',
  'NUXT_INTEGRATION_RATE_LIMIT_WINDOW_MS',
];

/** What the launcher passes to the kit's `prepareRuntimeEnv`. */
export const RUNTIME_ENV = { secrets: SECRETS, positiveIntegerVars: POSITIVE_INTEGER_VARS };
