import { dirname, join } from 'node:path';
import { SESSION_PASSWORD, type SecretSpec, TOKEN_VAULT_KEY, resolveSecret } from './secrets';

type Env = Record<string, string | undefined>;

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

  return { env, log };
}

function describeSource(source: string, spec: SecretSpec, dir: string): string {
  if (source === 'env') return `from ${spec.env}`;
  return `${source === 'generated' ? 'generated into' : 'loaded from'} ${join(dir, spec.file)}`;
}
