import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TempSecretsDir, existingInstallSecrets } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareRuntimeEnv } from './runtime-env';
import { InvalidSecretError, SESSION_PASSWORD, TDF_VAULT_KEY, TOKEN_VAULT_KEY, resolveSecret } from './secrets';

/**
 * An install that has already booted: `secrets/` holds today's three files (`value\n`, 0600, dir 0700).
 * Loading it must change nothing on disk, or every session, stored refresh token and TDF would be lost.
 */
type SecretFile = 'session-password' | 'token-vault.key' | 'tdf-vault.key';
const PAST = new Date('2020-01-01T00:00:00Z');

let install: TempSecretsDir;
let values: Record<SecretFile, string>;
beforeEach(() => {
  values = {
    'session-password': randomBytes(32).toString('base64url'),
    'token-vault.key': randomBytes(32).toString('base64'),
    'tdf-vault.key': randomBytes(32).toString('base64'),
  };
  install = existingInstallSecrets(values);
  age(install.secretsDir);
});
afterEach(() => install.cleanup());

/** Pins every mtime to the past, so a rewrite in the same millisecond still shows. */
function age(dir: string) {
  for (const name of readdirSync(dir)) utimesSync(join(dir, name), PAST, PAST);
  utimesSync(dir, PAST, PAST);
}

/** Listing, bytes, mode and mtime of the secrets dir and everything in it. */
function snapshot(dir: string) {
  const entry = (path: string) => {
    const s = statSync(path);
    return { mode: s.mode & 0o777, ino: s.ino, mtimeMs: s.mtimeMs };
  };
  return {
    dir: entry(dir),
    files: readdirSync(dir)
      .sort()
      .map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8'), ...entry(join(dir, name)) })),
  };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error('expected it to throw');
}

const prepare = (extra: Record<string, string> = {}) =>
  prepareRuntimeEnv({ NUXT_DATABASE_PATH: install.databasePath, ...extra });

describe('an existing install', () => {
  it('loads its three secrets from their files, with the same values', () => {
    const { env } = prepare();

    expect(env.NUXT_SESSION_PASSWORD).toBe(values['session-password']);
    expect(env.NUXT_TOKEN_VAULT_KEY).toBe(values['token-vault.key']);
    expect(env.NUXT_TDF_VAULT_KEY).toBe(values['tdf-vault.key']);
  });

  it.each([
    ['session-password', SESSION_PASSWORD],
    ['token-vault.key', TOKEN_VAULT_KEY],
    ['tdf-vault.key', TDF_VAULT_KEY],
  ] as const)('resolves %s with source "file"', (file, spec) => {
    expect(resolveSecret(spec, { env: {}, dir: install.secretsDir })).toEqual({ value: values[file], source: 'file' });
  });

  it('says where each secret was loaded from, in order, and never what it is', () => {
    const { log } = prepare();

    const dir = install.secretsDir;
    expect(log).toEqual([
      `Session password: loaded from ${join(dir, 'session-password')}`,
      `Token vault key: loaded from ${join(dir, 'token-vault.key')}`,
      `TDF vault key: loaded from ${join(dir, 'tdf-vault.key')}`,
    ]);
    for (const value of Object.values(values)) expect(log.join('\n')).not.toContain(value);
  });

  it('writes, renames and re-modes nothing', () => {
    const before = snapshot(install.secretsDir);

    prepare();

    expect(snapshot(install.secretsDir)).toEqual(before);
    expect(before.dir.mode).toBe(0o700);
    expect(before.files.map((f) => [f.name, f.mode])).toEqual([
      ['session-password', 0o600],
      ['tdf-vault.key', 0o600],
      ['token-vault.key', 0o600],
    ]);
  });

  it('leaves looser modes from a manual restore as they are', () => {
    chmodSync(install.secretsDir, 0o755);
    chmodSync(join(install.secretsDir, 'token-vault.key'), 0o644);
    age(install.secretsDir);
    const before = snapshot(install.secretsDir);

    prepare();

    expect(snapshot(install.secretsDir)).toEqual(before);
    expect(before.dir.mode).toBe(0o755);
    expect(before.files.find((f) => f.name === 'token-vault.key')!.mode).toBe(0o644);
  });

  it('still lets env overrides win, leaving the files alone', () => {
    const before = snapshot(install.secretsDir);
    const overrides = {
      NUXT_SESSION_PASSWORD: randomBytes(32).toString('base64url'),
      NUXT_TOKEN_VAULT_KEY: randomBytes(32).toString('base64'),
      NUXT_TDF_VAULT_KEY: randomBytes(32).toString('base64'),
    };

    const { env, log } = prepare(overrides);

    expect(env).toMatchObject(overrides);
    expect(log).toEqual([
      'Session password: from NUXT_SESSION_PASSWORD',
      'Token vault key: from NUXT_TOKEN_VAULT_KEY',
      'TDF vault key: from NUXT_TDF_VAULT_KEY',
    ]);
    expect(snapshot(install.secretsDir)).toEqual(before);
  });

  it.each([
    ['session-password', 'short', 'must be at least 32 characters'],
    ['token-vault.key', 'not-a-key', 'must be 32 bytes, base64-encoded'],
    ['tdf-vault.key', 'not-a-key', 'must be 32 bytes, base64-encoded'],
  ])('fails startup on a malformed %s with the same message, regenerating nothing', (file, bad, problem) => {
    const path = join(install.secretsDir, file);
    writeFileSync(path, `${bad}\n`);
    age(install.secretsDir);
    const before = snapshot(install.secretsDir);

    const error = thrownBy(() => prepare());

    expect(error).toBeInstanceOf(InvalidSecretError);
    expect((error as Error).message).toBe(
      `Invalid secret in file ${path}: ${problem}. Fix or remove it; it is never regenerated automatically.`,
    );
    expect(snapshot(install.secretsDir)).toEqual(before);
  });
});
