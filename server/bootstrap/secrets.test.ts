import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_PASSWORD, TOKEN_VAULT_KEY, resolveSecret } from './secrets';

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'secrets-')), 'secrets');
});
afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

const mode = (path: string) => statSync(path).mode & 0o777;

describe('resolveSecret', () => {
  it('generates a missing secret once into the secrets dir, readable only by the owner', () => {
    const result = resolveSecret(SESSION_PASSWORD, { env: {}, dir });

    expect(result.source).toBe('generated');
    const file = join(dir, 'session-password');
    expect(readFileSync(file, 'utf8').trim()).toBe(result.value);
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
  });

  it('reuses the generated secret on the next boot', () => {
    const first = resolveSecret(SESSION_PASSWORD, { env: {}, dir });
    const second = resolveSecret(SESSION_PASSWORD, { env: {}, dir });

    expect(second).toEqual({ value: first.value, source: 'file' });
  });

  it('prefers the env var over the file and leaves the dir alone', () => {
    const fromEnv = 'x'.repeat(40);
    const result = resolveSecret(SESSION_PASSWORD, { env: { NUXT_SESSION_PASSWORD: fromEnv }, dir });

    expect(result).toEqual({ value: fromEnv, source: 'env' });
    expect(existsSync(dir)).toBe(false);
  });

  it('treats an empty env var as unset', () => {
    expect(resolveSecret(SESSION_PASSWORD, { env: { NUXT_SESSION_PASSWORD: '' }, dir }).source).toBe('generated');
  });
});

describe('malformed secrets fail startup and are never regenerated', () => {
  it('rejects a too-short session password from env, naming the variable but not the value', () => {
    const run = () => resolveSecret(SESSION_PASSWORD, { env: { NUXT_SESSION_PASSWORD: 'hunter2-short' }, dir });

    expect(run).toThrow(/NUXT_SESSION_PASSWORD/);
    expect(run).not.toThrow(/hunter2/);
  });

  it('rejects a corrupted secrets file and leaves it in place', () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'token-vault.key');
    writeFileSync(file, 'not-a-key\n');

    expect(() => resolveSecret(TOKEN_VAULT_KEY, { env: {}, dir })).toThrow(file);
    expect(readFileSync(file, 'utf8')).toBe('not-a-key\n');
  });

  it.each([
    ['too short', randomBytes(16).toString('base64')],
    ['too long', randomBytes(33).toString('base64')],
    ['not base64', '!'.repeat(44)],
  ])('rejects a vault key that is %s', (_label, key) => {
    expect(() => resolveSecret(TOKEN_VAULT_KEY, { env: { NUXT_TOKEN_VAULT_KEY: key }, dir })).toThrow(/NUXT_TOKEN_VAULT_KEY/);
  });

  it('accepts a 32-byte base64 vault key from env', () => {
    const key = randomBytes(32).toString('base64');
    expect(resolveSecret(TOKEN_VAULT_KEY, { env: { NUXT_TOKEN_VAULT_KEY: key }, dir }).value).toBe(key);
  });

  it('generates a vault key that decodes to 32 bytes', () => {
    const { value } = resolveSecret(TOKEN_VAULT_KEY, { env: {}, dir });
    expect(Buffer.from(value, 'base64')).toHaveLength(32);
  });
});
