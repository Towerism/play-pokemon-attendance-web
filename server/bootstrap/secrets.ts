import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Secrets come from env, else from a file generated once in the secrets dir
 * (ADR-0006). Env always wins. A malformed value fails startup loudly and is
 * never silently regenerated: regenerating would log everyone out or orphan the
 * stored refresh token.
 */
export interface SecretSpec {
  /** Env var that overrides the file. */
  env: string;
  /** File name inside the secrets dir. */
  file: string;
  generate(): string;
  /** Returns why the value is unusable, or `null` when it is fine. Never echo the value. */
  problem(value: string): string | null;
}

export type SecretSource = 'env' | 'file' | 'generated';

export class InvalidSecretError extends Error {
  override name = 'InvalidSecretError';
}

export const SESSION_PASSWORD: SecretSpec = {
  env: 'NUXT_SESSION_PASSWORD',
  file: 'session-password',
  generate: () => randomBytes(32).toString('base64url'),
  // nuxt-auth-utils (iron) needs at least 32 characters.
  problem: (v) => (v.length >= 32 ? null : 'must be at least 32 characters'),
};

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export const TOKEN_VAULT_KEY: SecretSpec = {
  env: 'NUXT_TOKEN_VAULT_KEY',
  file: 'token-vault.key',
  generate: () => randomBytes(32).toString('base64'),
  // AES-256-GCM key (ADR-0003).
  problem: (v) =>
    BASE64.test(v) && Buffer.from(v, 'base64').length === 32 ? null : 'must be 32 bytes, base64-encoded',
};

export function resolveSecret(
  spec: SecretSpec,
  opts: { env: Record<string, string | undefined>; dir: string },
): { value: string; source: SecretSource } {
  const fromEnv = opts.env[spec.env];
  if (fromEnv) return { value: check(spec, fromEnv, `env var ${spec.env}`), source: 'env' };

  const path = join(opts.dir, spec.file);
  const fromFile = readIfExists(path);
  if (fromFile !== undefined) return { value: check(spec, fromFile, `file ${path}`), source: 'file' };

  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const value = spec.generate();
  writeFileSync(path, `${value}\n`, { mode: 0o600, flag: 'wx' });
  return { value, source: 'generated' };
}

function check(spec: SecretSpec, value: string, where: string): string {
  const problem = spec.problem(value);
  if (problem) {
    throw new InvalidSecretError(
      `Invalid secret in ${where}: ${problem}. Fix or remove it; it is never regenerated automatically.`,
    );
  }
  return value;
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
