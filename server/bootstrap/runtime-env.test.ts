import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidConfigError, prepareRuntimeEnv } from './runtime-env';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'data-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const base = () => ({ NUXT_DATABASE_PATH: join(dataDir, 'app.db') });

describe('prepareRuntimeEnv', () => {
  it('puts generated secrets in a secrets dir next to the database and exports them', () => {
    const { env } = prepareRuntimeEnv(base());

    expect(env.NUXT_SESSION_PASSWORD).toHaveLength(43);
    expect(Buffer.from(env.NUXT_TOKEN_VAULT_KEY!, 'base64')).toHaveLength(32);
    expect(statSync(join(dataDir, 'secrets', 'session-password')).isFile()).toBe(true);
    expect(statSync(join(dataDir, 'secrets', 'token-vault.key')).isFile()).toBe(true);
    expect(Buffer.from(env.NUXT_TDF_VAULT_KEY!, 'base64')).toHaveLength(32);
    expect(statSync(join(dataDir, 'secrets', 'tdf-vault.key')).isFile()).toBe(true);
  });

  it('keeps the secrets stable across restarts', () => {
    const first = prepareRuntimeEnv(base()).env;
    const second = prepareRuntimeEnv(base()).env;

    expect(second.NUXT_SESSION_PASSWORD).toBe(first.NUXT_SESSION_PASSWORD);
    expect(second.NUXT_TOKEN_VAULT_KEY).toBe(first.NUXT_TOKEN_VAULT_KEY);
    expect(second.NUXT_TDF_VAULT_KEY).toBe(first.NUXT_TDF_VAULT_KEY);
  });

  it('logs where each secret came from without ever logging a value', () => {
    const { env, log } = prepareRuntimeEnv(base());

    expect(log.join('\n')).toMatch(/session password.*generated/i);
    expect(log.join('\n')).toMatch(/token vault key.*generated/i);
    expect(log.join('\n')).toMatch(/TDF vault key.*generated/i);
    for (const line of log) {
      expect(line).not.toContain(env.NUXT_SESSION_PASSWORD);
      expect(line).not.toContain(env.NUXT_TOKEN_VAULT_KEY);
      expect(line).not.toContain(env.NUXT_TDF_VAULT_KEY);
    }
  });

  it('does not mutate the input env', () => {
    const input = base();
    prepareRuntimeEnv(input);
    expect(input).toEqual(base());
  });

  describe('session cookie Secure flag (ADR-0006: plain HTTP on the LAN works)', () => {
    it.each([
      [undefined, 'false'],
      ['http://tower:3000', 'false'],
      ['https://attendance.example.com', 'true'],
      ['HTTPS://ATTENDANCE.EXAMPLE.COM', 'true'],
    ])('site url %j → secure=%s', (siteUrl, secure) => {
      const { env } = prepareRuntimeEnv({ ...base(), NUXT_PUBLIC_SITE_URL: siteUrl });
      expect(env.NUXT_SESSION_COOKIE_SECURE).toBe(secure);
    });

    it('respects an explicit override', () => {
      const { env } = prepareRuntimeEnv({ ...base(), NUXT_SESSION_COOKIE_SECURE: 'true' });
      expect(env.NUXT_SESSION_COOKIE_SECURE).toBe('true');
    });
  });

  describe('auth rate-limit tuning', () => {
    const VARS = [
      'NUXT_AUTH_RATE_LIMIT_LOGIN_MAX',
      'NUXT_AUTH_RATE_LIMIT_LOGIN_WINDOW_MS',
      'NUXT_AUTH_RATE_LIMIT_SETUP_MAX',
      'NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS',
    ];

    it.each(VARS.flatMap((name) => ['0', '-1', 'abc', '1.5', '10x'].map((value) => [name, value])))(
      'fails startup for %s=%j, naming the variable',
      (name, value) => {
        expect(() => prepareRuntimeEnv({ ...base(), [name]: value })).toThrow(InvalidConfigError);
        expect(() => prepareRuntimeEnv({ ...base(), [name]: value })).toThrow(name);
      },
    );

    it('accepts positive integers', () => {
      const { env } = prepareRuntimeEnv({ ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '3', NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS: '1000' });
      expect(env.NUXT_AUTH_RATE_LIMIT_LOGIN_MAX).toBe('3');
      expect(env.NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS).toBe('1000');
    });

    it('treats an empty value as unset, so the default applies', () => {
      const { env } = prepareRuntimeEnv({ ...base(), NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: ' ' });
      expect(env).not.toHaveProperty('NUXT_AUTH_RATE_LIMIT_LOGIN_MAX');
    });
  });

  describe('trusted proxies', () => {
    it.each(['10.0.0.0/33', 'not-an-ip'])('fails startup for NUXT_TRUSTED_PROXIES=%j, naming the variable and the entry', (value) => {
      expect(() => prepareRuntimeEnv({ ...base(), NUXT_TRUSTED_PROXIES: value })).toThrow(InvalidConfigError);
      expect(() => prepareRuntimeEnv({ ...base(), NUXT_TRUSTED_PROXIES: value })).toThrow(new RegExp(`NUXT_TRUSTED_PROXIES.*"${value.replace(/[./]/g, '\\$&')}"`));
    });

    it.each(['none', '10.0.0.5, 2001:db8::/32', '', '   '])('accepts %j', (value) => {
      expect(() => prepareRuntimeEnv({ ...base(), NUXT_TRUSTED_PROXIES: value })).not.toThrow();
    });
  });
});
