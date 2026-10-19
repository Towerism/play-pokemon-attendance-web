import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidConfigError, InvalidSecretError } from '@towerism/selfhost-kit';
import { type TempSecretsDir, existingInstallSecrets, tempSecretsDir } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devEnvHook, prepareDevEnv } from './dev-env';

/**
 * `pnpm dev` never runs the production launcher, so the dev hook resolves the same secrets and runtime env
 * (`RUNTIME_ENV`) into `process.env` before the Nitro dev server loads. Each test gets a fresh data folder and
 * its own env object, never the real `process.env`.
 */
let data: TempSecretsDir;
beforeEach(() => {
  data = tempSecretsDir();
});
afterEach(() => data.cleanup());

const AES_256_KEY = /^[A-Za-z0-9+/]{43}=$/;
/** mtimes are pinned here first, so a rewrite in the same millisecond still shows. */
const PAST = new Date('2020-01-01T00:00:00Z');
const readSecret = (file: string) => readFileSync(join(data.secretsDir, file), 'utf8').trim();

/** Bytes, mode, inode and mtime of every file in the secrets dir. */
function fileStates() {
  return readdirSync(data.secretsDir)
    .sort()
    .map((name) => {
      const path = join(data.secretsDir, name);
      const s = statSync(path);
      return { name, content: readFileSync(path, 'utf8'), mode: s.mode & 0o777, ino: s.ino, mtimeMs: s.mtimeMs };
    });
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error('expected it to throw');
}

describe('prepareDevEnv', () => {
  it('generates the secrets on a first dev boot and puts them in the env', () => {
    const env: NodeJS.ProcessEnv = { NUXT_DATABASE_PATH: data.databasePath };

    prepareDevEnv(env, recordingLogger());

    expect(env.NUXT_TOKEN_VAULT_KEY).toMatch(AES_256_KEY);
    expect(env.NUXT_TDF_VAULT_KEY).toMatch(AES_256_KEY);
    expect(env.NUXT_MESSAGE_VAULT_KEY).toMatch(AES_256_KEY);
    expect(env.NUXT_SESSION_PASSWORD!.length).toBeGreaterThanOrEqual(32);
    expect(readSecret('token-vault.key')).toBe(env.NUXT_TOKEN_VAULT_KEY);
    expect(readSecret('tdf-vault.key')).toBe(env.NUXT_TDF_VAULT_KEY);
    expect(readSecret('message-vault.key')).toBe(env.NUXT_MESSAGE_VAULT_KEY);
    expect(readSecret('session-password')).toBe(env.NUXT_SESSION_PASSWORD);
  });

  it('drops a blank tuning variable, as the launcher does, so runtime config keeps its default', () => {
    const env: NodeJS.ProcessEnv = { NUXT_DATABASE_PATH: data.databasePath, NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '' };

    prepareDevEnv(env, recordingLogger());

    expect(env).not.toHaveProperty('NUXT_AUTH_RATE_LIMIT_LOGIN_MAX');
  });

  it('reuses the secrets of an earlier dev boot and leaves their files untouched', () => {
    const values = {
      'session-password': randomBytes(32).toString('base64url'),
      'token-vault.key': randomBytes(32).toString('base64'),
      'tdf-vault.key': randomBytes(32).toString('base64'),
      'message-vault.key': randomBytes(32).toString('base64'),
    };
    data.cleanup();
    data = existingInstallSecrets(values);
    for (const file of Object.keys(values)) utimesSync(join(data.secretsDir, file), PAST, PAST);
    const before = fileStates();
    const env: NodeJS.ProcessEnv = { NUXT_DATABASE_PATH: data.databasePath };

    prepareDevEnv(env, recordingLogger());

    expect(env.NUXT_SESSION_PASSWORD).toBe(values['session-password']);
    expect(env.NUXT_TOKEN_VAULT_KEY).toBe(values['token-vault.key']);
    expect(env.NUXT_TDF_VAULT_KEY).toBe(values['tdf-vault.key']);
    expect(env.NUXT_MESSAGE_VAULT_KEY).toBe(values['message-vault.key']);
    expect(fileStates()).toEqual(before);
  });

  it("keeps the session password nuxt-auth-utils put in .env and writes no file for it", () => {
    const fromDotenv = randomBytes(32).toString('base64url');
    const env: NodeJS.ProcessEnv = { NUXT_DATABASE_PATH: data.databasePath, NUXT_SESSION_PASSWORD: fromDotenv };

    prepareDevEnv(env, recordingLogger());

    expect(env.NUXT_SESSION_PASSWORD).toBe(fromDotenv);
    expect(existsSync(join(data.secretsDir, 'session-password'))).toBe(false);
  });

  it('refuses a malformed vault key from env without echoing it or generating a replacement', () => {
    const env: NodeJS.ProcessEnv = { NUXT_DATABASE_PATH: data.databasePath, NUXT_TOKEN_VAULT_KEY: 'not-a-key' };

    const err = thrownBy(() => prepareDevEnv(env, recordingLogger()));

    expect(err).toBeInstanceOf(InvalidSecretError);
    expect((err as Error).message).toContain('NUXT_TOKEN_VAULT_KEY');
    expect((err as Error).message).not.toContain('not-a-key');
    expect(existsSync(join(data.secretsDir, 'token-vault.key'))).toBe(false);
  });

  it('refuses a malformed vault key file and leaves it as it is', () => {
    data.cleanup();
    data = existingInstallSecrets({ 'token-vault.key': 'truncated' });
    const env: NodeJS.ProcessEnv = { NUXT_DATABASE_PATH: data.databasePath };

    const err = thrownBy(() => prepareDevEnv(env, recordingLogger()));

    expect(err).toBeInstanceOf(InvalidSecretError);
    expect((err as Error).message).toContain(join(data.secretsDir, 'token-vault.key'));
    expect(readSecret('token-vault.key')).toBe('truncated');
  });

  it('refuses a tuning variable that is not a whole number', () => {
    const env: NodeJS.ProcessEnv = { NUXT_DATABASE_PATH: data.databasePath, NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: 'abc' };

    expect(() => prepareDevEnv(env, recordingLogger())).toThrow(InvalidConfigError);
  });

  it('logs where each secret came from, and never a secret value', () => {
    const env: NodeJS.ProcessEnv = { NUXT_DATABASE_PATH: data.databasePath };
    const logger = recordingLogger();

    prepareDevEnv(env, logger);

    expect(logger.lines.map((l) => [l.level, l.msg])).toEqual([
      ['info', `Session password: generated into ${join(data.secretsDir, 'session-password')}`],
      ['info', `Token vault key: generated into ${join(data.secretsDir, 'token-vault.key')}`],
      ['info', `TDF vault key: generated into ${join(data.secretsDir, 'tdf-vault.key')}`],
      ['info', `Message vault key: generated into ${join(data.secretsDir, 'message-vault.key')}`],
    ]);
    const logged = JSON.stringify(logger.lines);
    for (const name of ['NUXT_SESSION_PASSWORD', 'NUXT_TOKEN_VAULT_KEY', 'NUXT_TDF_VAULT_KEY', 'NUXT_MESSAGE_VAULT_KEY']) {
      expect(logged).not.toContain(env[name]);
    }
  });
});

describe('devEnvHook', () => {
  it('prepares the env when Nuxt runs in dev', () => {
    const env: NodeJS.ProcessEnv = { NUXT_DATABASE_PATH: data.databasePath };

    devEnvHook({ options: { dev: true } }, { env, logger: recordingLogger() });

    expect(env.NUXT_TOKEN_VAULT_KEY).toMatch(AES_256_KEY);
    expect(readSecret('token-vault.key')).toBe(env.NUXT_TOKEN_VAULT_KEY);
  });

  it('touches neither env nor disk outside dev (build, prepare, typecheck)', () => {
    const env: NodeJS.ProcessEnv = { NUXT_DATABASE_PATH: data.databasePath, NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '' };
    const logger = recordingLogger();

    devEnvHook({ options: { dev: false } }, { env, logger });

    expect(env).toEqual({ NUXT_DATABASE_PATH: data.databasePath, NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '' });
    expect(logger.lines).toEqual([]);
    expect(existsSync(data.secretsDir)).toBe(false);
  });
});

type Line = { level: 'error' | 'warn' | 'info' | 'debug'; msg: string; fields?: Record<string, unknown> };

/** A Logger that keeps every line it's given. */
function recordingLogger(lines: Line[] = []) {
  const at = (level: Line['level']) => (msg: string, fields?: Record<string, unknown>) => lines.push({ level, msg, fields });
  const logger = { lines, error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), child: () => logger };
  return logger;
}
