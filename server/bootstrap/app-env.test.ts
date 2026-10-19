import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TempSecretsDir, existingInstallSecrets, tempSecretsDir } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidConfigError, InvalidSecretError, prepareRuntimeEnv, resolveSecret } from '@towerism/selfhost-kit';
import { POSITIVE_INTEGER_VARS, RUNTIME_ENV, SECRETS } from './app-env';

const [SESSION_PASSWORD, TOKEN_VAULT_KEY, TDF_VAULT_KEY, MESSAGE_VAULT_KEY] = SECRETS;

/**
 * Attendance's configuration of the kit's secrets and runtime env (the launcher passes `RUNTIME_ENV`).
 * The kit's own tests cover the mechanics; these pin what an existing install depends on.
 *
 * An install that has already booted: `secrets/` holds today's four files (`value\n`, 0600, dir 0700).
 * Loading it must change nothing on disk, or every session, stored refresh token, TDF and waiting link would be lost.
 */
type SecretFile = 'session-password' | 'token-vault.key' | 'tdf-vault.key' | 'message-vault.key';
const PAST = new Date('2020-01-01T00:00:00Z');

let install: TempSecretsDir;
let values: Record<SecretFile, string>;
beforeEach(() => {
  values = {
    'session-password': randomBytes(32).toString('base64url'),
    'token-vault.key': randomBytes(32).toString('base64'),
    'tdf-vault.key': randomBytes(32).toString('base64'),
    'message-vault.key': randomBytes(32).toString('base64'),
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
  prepareRuntimeEnv({ NUXT_DATABASE_PATH: install.databasePath, ...extra }, RUNTIME_ENV);

describe('an existing install', () => {
  it('loads its four secrets from their files, with the same values', () => {
    const { env } = prepare();

    expect(env.NUXT_SESSION_PASSWORD).toBe(values['session-password']);
    expect(env.NUXT_TOKEN_VAULT_KEY).toBe(values['token-vault.key']);
    expect(env.NUXT_TDF_VAULT_KEY).toBe(values['tdf-vault.key']);
    expect(env.NUXT_MESSAGE_VAULT_KEY).toBe(values['message-vault.key']);
  });

  it.each([
    ['session-password', SESSION_PASSWORD],
    ['token-vault.key', TOKEN_VAULT_KEY],
    ['tdf-vault.key', TDF_VAULT_KEY],
    ['message-vault.key', MESSAGE_VAULT_KEY],
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
      `Message vault key: loaded from ${join(dir, 'message-vault.key')}`,
    ]);
    for (const value of Object.values(values)) expect(log.join('\n')).not.toContain(value);
  });

  it('writes, renames and re-modes nothing', () => {
    const before = snapshot(install.secretsDir);

    prepare();

    expect(snapshot(install.secretsDir)).toEqual(before);
    expect(before.dir.mode).toBe(0o700);
    expect(before.files.map((f) => [f.name, f.mode])).toEqual([
      ['message-vault.key', 0o600],
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
      NUXT_MESSAGE_VAULT_KEY: randomBytes(32).toString('base64'),
    };

    const { env, log } = prepare(overrides);

    expect(env).toMatchObject(overrides);
    expect(log).toEqual([
      'Session password: from NUXT_SESSION_PASSWORD',
      'Token vault key: from NUXT_TOKEN_VAULT_KEY',
      'TDF vault key: from NUXT_TDF_VAULT_KEY',
      'Message vault key: from NUXT_MESSAGE_VAULT_KEY',
    ]);
    expect(snapshot(install.secretsDir)).toEqual(before);
  });

  it.each([
    ['session-password', 'short', 'must be at least 32 characters'],
    ['token-vault.key', 'not-a-key', 'must be 32 bytes, base64-encoded'],
    ['tdf-vault.key', 'not-a-key', 'must be 32 bytes, base64-encoded'],
    ['message-vault.key', 'not-a-key', 'must be 32 bytes, base64-encoded'],
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

describe('an install upgraded from the release before the Discord channel (three secrets)', () => {
  let upgraded: TempSecretsDir;
  let three: Record<string, string>;
  beforeEach(() => {
    three = {
      'session-password': randomBytes(32).toString('base64url'),
      'token-vault.key': randomBytes(32).toString('base64'),
      'tdf-vault.key': randomBytes(32).toString('base64'),
    };
    upgraded = existingInstallSecrets(three);
    age(upgraded.secretsDir);
  });
  afterEach(() => upgraded.cleanup());

  it('generates the message vault key once, owner-only, and leaves the other three as they were', () => {
    const before = snapshot(upgraded.secretsDir).files;

    const { env, log } = prepareRuntimeEnv({ NUXT_DATABASE_PATH: upgraded.databasePath }, RUNTIME_ENV);

    expect(log.at(-1)).toBe(`Message vault key: generated into ${join(upgraded.secretsDir, 'message-vault.key')}`);
    const after = snapshot(upgraded.secretsDir).files;
    expect(after.filter((f) => f.name !== 'message-vault.key')).toEqual(before);
    const key = after.find((f) => f.name === 'message-vault.key')!;
    expect(key.mode).toBe(0o600);
    expect(key.content).toBe(`${env.NUXT_MESSAGE_VAULT_KEY}\n`);

    const again = prepareRuntimeEnv({ NUXT_DATABASE_PATH: upgraded.databasePath }, RUNTIME_ENV);
    expect(again.env.NUXT_MESSAGE_VAULT_KEY).toBe(env.NUXT_MESSAGE_VAULT_KEY);
  });
});

describe('a first boot (empty data folder)', () => {
  let fresh: TempSecretsDir;
  beforeEach(() => {
    fresh = tempSecretsDir();
  });
  afterEach(() => fresh.cleanup());

  it('generates the four secret files, owner-only, and says so in order', () => {
    const { env, log } = prepareRuntimeEnv({ NUXT_DATABASE_PATH: fresh.databasePath }, RUNTIME_ENV);

    const dir = fresh.secretsDir;
    expect(log).toEqual([
      `Session password: generated into ${join(dir, 'session-password')}`,
      `Token vault key: generated into ${join(dir, 'token-vault.key')}`,
      `TDF vault key: generated into ${join(dir, 'tdf-vault.key')}`,
      `Message vault key: generated into ${join(dir, 'message-vault.key')}`,
    ]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const spec of SECRETS) {
      const file = join(dir, spec.file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, 'utf8')).toBe(`${env[spec.env]}\n`);
      expect(log.join('\n')).not.toContain(env[spec.env]);
    }
  });
});

describe("attendance's secret specs", () => {
  it('keep their env names, file names and log labels, in startup order', () => {
    expect(SECRETS.map((spec) => [spec.env, spec.file, spec.label])).toEqual([
      ['NUXT_SESSION_PASSWORD', 'session-password', 'Session password'],
      ['NUXT_TOKEN_VAULT_KEY', 'token-vault.key', 'Token vault key'],
      ['NUXT_TDF_VAULT_KEY', 'tdf-vault.key', 'TDF vault key'],
      ['NUXT_MESSAGE_VAULT_KEY', 'message-vault.key', 'Message vault key'],
    ]);
  });

  it('are what the launcher resolves', () => {
    expect(RUNTIME_ENV.secrets).toBe(SECRETS);
    expect(RUNTIME_ENV.positiveIntegerVars).toBe(POSITIVE_INTEGER_VARS);
  });

  it('need a session password of at least 32 characters', () => {
    expect(SESSION_PASSWORD.problem('x'.repeat(31))).toBe('must be at least 32 characters');
    expect(SESSION_PASSWORD.problem('x'.repeat(32))).toBeNull();
    expect(SESSION_PASSWORD.problem(SESSION_PASSWORD.generate())).toBeNull();
  });

  describe.each([
    ['token', TOKEN_VAULT_KEY],
    ['TDF', TDF_VAULT_KEY],
    ['message', MESSAGE_VAULT_KEY],
  ])('the %s vault key', (_label, spec) => {
    it.each([
      ['16 bytes', randomBytes(16).toString('base64')],
      ['33 bytes', randomBytes(33).toString('base64')],
      ['not base64', '!'.repeat(44)],
    ])('is refused when it is %s', (_what, key) => {
      expect(spec.problem(key)).toBe('must be 32 bytes, base64-encoded');
    });

    it('is generated as 32 bytes of base64 that pass its own rule', () => {
      const key = spec.generate();
      expect(Buffer.from(key, 'base64')).toHaveLength(32);
      expect(spec.problem(key)).toBeNull();
    });
  });
});

describe('auth rate-limit tuning', () => {
  const base = () => ({ NUXT_DATABASE_PATH: install.databasePath });

  it('checks exactly these variables', () => {
    expect(POSITIVE_INTEGER_VARS).toEqual([
      'NUXT_AUTH_RATE_LIMIT_LOGIN_MAX',
      'NUXT_AUTH_RATE_LIMIT_LOGIN_WINDOW_MS',
      'NUXT_AUTH_RATE_LIMIT_SETUP_MAX',
      'NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS',
      'NUXT_INTEGRATION_RATE_LIMIT_MAX',
      'NUXT_INTEGRATION_RATE_LIMIT_WINDOW_MS',
      'NUXT_INVITE_RATE_LIMIT_MAX',
      'NUXT_INVITE_RATE_LIMIT_WINDOW_MS',
      'NUXT_MESSAGE_POLL_RATE_LIMIT_MAX',
      'NUXT_MESSAGE_POLL_RATE_LIMIT_WINDOW_MS',
      'NUXT_MESSAGE_RESULT_RATE_LIMIT_MAX',
      'NUXT_MESSAGE_RESULT_RATE_LIMIT_WINDOW_MS',
      'NUXT_MESSAGING_SEND_WAIT_MS',
    ]);
  });

  // 2^53 and 2^53 + 1 are whole digits but not safe integers, which the limiter can't use.
  const refused = ['0', '-1', 'abc', '1.5', '10x', '9007199254740992', '9007199254740993'];

  it.each(POSITIVE_INTEGER_VARS.flatMap((name) => refused.map((value) => [name, value])))(
    'fails startup for %s=%j, naming the variable',
    (name, value) => {
      expect(() => prepareRuntimeEnv({ ...base(), [name]: value }, RUNTIME_ENV)).toThrow(InvalidConfigError);
      expect(() => prepareRuntimeEnv({ ...base(), [name]: value }, RUNTIME_ENV)).toThrow(name);
    },
  );

  it('accepts positive integers', () => {
    const { env } = prepareRuntimeEnv(
      { ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '3', NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS: '1000' },
      RUNTIME_ENV,
    );
    expect(env.NUXT_AUTH_RATE_LIMIT_LOGIN_MAX).toBe('3');
    expect(env.NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS).toBe('1000');
  });

  it('accepts the largest safe integer', () => {
    const { env } = prepareRuntimeEnv({ ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '9007199254740991' }, RUNTIME_ENV);
    expect(env.NUXT_AUTH_RATE_LIMIT_LOGIN_MAX).toBe('9007199254740991');
  });

  it('passes an accepted value on without its surrounding spaces', () => {
    const { env } = prepareRuntimeEnv({ ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: ' 5 ' }, RUNTIME_ENV);
    expect(env.NUXT_AUTH_RATE_LIMIT_LOGIN_MAX).toBe('5');
  });

  it('treats an empty value as unset, so the default applies', () => {
    const { env } = prepareRuntimeEnv({ ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: ' ' }, RUNTIME_ENV);
    expect(env).not.toHaveProperty('NUXT_AUTH_RATE_LIMIT_LOGIN_MAX');
  });
});
