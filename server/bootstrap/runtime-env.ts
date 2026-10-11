import { dirname, join } from 'node:path';
import { InvalidTrustedProxiesError, parseTrustedProxies } from '../modules/security/client-address';
import { SESSION_PASSWORD, type SecretSpec, TOKEN_VAULT_KEY, resolveSecret } from './secrets';

type Env = Record<string, string | undefined>;

export class InvalidConfigError extends Error {
  override name = 'InvalidConfigError';
}

/** Same default as `runtimeConfig.databasePath`; the image sets `/data/app.db`. */
const DEFAULT_DATABASE_PATH = '.data/app.db';

const SECRETS: Array<[label: string, spec: SecretSpec]> = [
  ['Session password', SESSION_PASSWORD],
  ['Token vault key', TOKEN_VAULT_KEY],
];

/**
 * Env for the Nitro server, worked out before it loads (Nitro reads runtime
 * config from env once, at import). Secrets live in `secrets/` next to the
 * database, so everything persistent sits under one volume (ADR-0006).
 */
export function prepareRuntimeEnv(input: Env): { env: Env; log: string[] } {
  const env: Env = { ...input };
  const log: string[] = [];
  const secretsDir = join(dirname(env.NUXT_DATABASE_PATH || DEFAULT_DATABASE_PATH), 'secrets');

  for (const [label, spec] of SECRETS) {
    const { value, source } = resolveSecret(spec, { env, dir: secretsDir });
    env[spec.env] = value;
    log.push(`${label}: ${describeSource(source, spec, secretsDir)}`);
  }

  if (!env.NUXT_SESSION_COOKIE_SECURE) {
    const siteUrl = env.NUXT_PUBLIC_SITE_URL ?? '';
    env.NUXT_SESSION_COOKIE_SECURE = String(siteUrl.toLowerCase().startsWith('https:'));
  }

  for (const name of RATE_LIMIT_VARS) {
    const value = env[name]?.trim();
    if (!value) delete env[name];
    else if (!/^[1-9]\d*$/.test(value)) throw new InvalidConfigError(`${name} must be a whole number of at least 1 (got "${value}").`);
  }

  try {
    parseTrustedProxies(env.NUXT_TRUSTED_PROXIES ?? '');
  } catch (err) {
    if (err instanceof InvalidTrustedProxiesError) throw new InvalidConfigError(err.message);
    throw err;
  }

  return { env, log };
}

/** Optional tuning for `runtimeConfig.authRateLimit` (tests raise them; never in the template). */
const RATE_LIMIT_VARS = [
  'NUXT_AUTH_RATE_LIMIT_LOGIN_MAX',
  'NUXT_AUTH_RATE_LIMIT_LOGIN_WINDOW_MS',
  'NUXT_AUTH_RATE_LIMIT_SETUP_MAX',
  'NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS',
];

function describeSource(source: string, spec: SecretSpec, dir: string): string {
  if (source === 'env') return `from ${spec.env}`;
  return `${source === 'generated' ? 'generated into' : 'loaded from'} ${join(dir, spec.file)}`;
}
