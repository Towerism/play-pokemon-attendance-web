import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareRuntimeEnv } from './runtime-env';

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
  });

  it('keeps the secrets stable across restarts', () => {
    const first = prepareRuntimeEnv(base()).env;
    const second = prepareRuntimeEnv(base()).env;

    expect(second.NUXT_SESSION_PASSWORD).toBe(first.NUXT_SESSION_PASSWORD);
    expect(second.NUXT_TOKEN_VAULT_KEY).toBe(first.NUXT_TOKEN_VAULT_KEY);
  });

  it('logs where each secret came from without ever logging a value', () => {
    const { env, log } = prepareRuntimeEnv(base());

    expect(log.join('\n')).toMatch(/session password.*generated/i);
    expect(log.join('\n')).toMatch(/token vault key.*generated/i);
    for (const line of log) {
      expect(line).not.toContain(env.NUXT_SESSION_PASSWORD);
      expect(line).not.toContain(env.NUXT_TOKEN_VAULT_KEY);
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
});
