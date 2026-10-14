import { DEFAULT_TRUSTED_PROXIES, clientKey } from '@towerism/selfhost-kit';
import { describe, expect, it } from 'vitest';
import { type RateLimitConfig, buildRateLimits } from './rate-limits';

/** Today's runtime config defaults (nuxt.config.ts), with one setting overridden per test. */
function config(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    authRateLimit: { login: { max: 10, windowMs: 900_000 }, setup: { max: 5, windowMs: 900_000 } },
    integrationRateLimit: { max: 30, windowMs: 900_000 },
    trustedProxies: DEFAULT_TRUSTED_PROXIES,
    ...overrides,
  };
}

/** How many hits a limiter allows for one key before refusing (stops at `cap`). */
function allowed(limiter: { hit(key: string): { allowed: boolean } }, cap = 100): number {
  for (let i = 0; i < cap; i++) if (!limiter.hit('k').allowed) return i;
  return cap;
}

const LOGIN = 'NUXT_AUTH_RATE_LIMIT_LOGIN_MAX / NUXT_AUTH_RATE_LIMIT_LOGIN_WINDOW_MS';
const SETUP = 'NUXT_AUTH_RATE_LIMIT_SETUP_MAX / NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS';
const INTEGRATION = 'NUXT_INTEGRATION_RATE_LIMIT_MAX / NUXT_INTEGRATION_RATE_LIMIT_WINDOW_MS';

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected it to throw');
}

describe('buildRateLimits with valid settings', () => {
  it('builds the login, setup and integration limiters with their configured max', () => {
    const limits = buildRateLimits(config());
    expect(allowed(limits.auth.login)).toBe(10);
    expect(allowed(limits.auth.setup)).toBe(5);
    expect(allowed(limits.integration)).toBe(30);
  });

  it('coerces numeric strings for the integration limit, as before', () => {
    const limits = buildRateLimits(config({ integrationRateLimit: { max: '2', windowMs: '900000' } }));
    expect(allowed(limits.integration)).toBe(2);
  });

  it('parses the trusted proxies: a loopback proxy is believed, a LAN peer is not', () => {
    const { trusted } = buildRateLimits(config());
    expect(clientKey({ remoteAddress: '127.0.0.1', xForwardedFor: '203.0.113.9', trusted })).toBe('203.0.113.9');
    expect(clientKey({ remoteAddress: '192.168.1.20', xForwardedFor: '203.0.113.9', trusted })).toBe('192.168.1.20');
  });

  it('treats unset trusted proxies as blank, which is the default list, as before', () => {
    const { trusted } = buildRateLimits(config({ trustedProxies: undefined }));
    expect(clientKey({ remoteAddress: '127.0.0.1', xForwardedFor: '203.0.113.9', trusted })).toBe('203.0.113.9');
    expect(clientKey({ remoteAddress: '192.168.1.20', xForwardedFor: '203.0.113.9', trusted })).toBe('192.168.1.20');
  });

  it("trusts no proxy for 'none'", () => {
    const { trusted } = buildRateLimits(config({ trustedProxies: 'none' }));
    expect(clientKey({ remoteAddress: '127.0.0.1', xForwardedFor: '203.0.113.9', trusted })).toBe('127.0.0.1');
  });
});

describe('buildRateLimits with a setting the limiter refuses', () => {
  const bad = [
    { max: 0, windowMs: 900_000 },
    { max: 2.5, windowMs: 900_000 },
    { max: '5', windowMs: 900_000 },
    { max: 10, windowMs: -1 },
    { max: 2 ** 53, windowMs: 900_000 },
  ];

  it.each(bad)('names the login variables for %j', (login) => {
    const err = thrown(() => buildRateLimits(config({ authRateLimit: { ...config().authRateLimit, login } })));
    expect(err.message).toMatch(new RegExp(`^Invalid rate limit \\(${LOGIN}, or their NITRO_ or JSON-object override\\): The rate limiter's`));
    expect(err.cause).toBeInstanceOf(RangeError);
  });

  it.each(bad)('names the setup variables for %j', (setup) => {
    const err = thrown(() => buildRateLimits(config({ authRateLimit: { ...config().authRateLimit, setup } })));
    expect(err.message).toMatch(new RegExp(`^Invalid rate limit \\(${SETUP}, or their NITRO_ or JSON-object override\\): `));
    expect(err.cause).toBeInstanceOf(RangeError);
  });

  it.each([0, ''])('names the integration variables for max %j', (max) => {
    const err = thrown(() => buildRateLimits(config({ integrationRateLimit: { max, windowMs: 900_000 } })));
    expect(err.message).toMatch(new RegExp(`^Invalid rate limit \\(${INTEGRATION}, or their NITRO_ or JSON-object override\\): `));
    expect(err.cause).toBeInstanceOf(RangeError);
  });

  it("rethrows the trusted-proxy parser's own error, which already names the variable", () => {
    const err = thrown(() => buildRateLimits(config({ trustedProxies: '10.0.0.0/33' })));
    expect(err.message).toMatch(/^NUXT_TRUSTED_PROXIES has an invalid entry "10\.0\.0\.0\/33"/);
  });

  it('puts no configured value in a limiter message', () => {
    const err = thrown(() => buildRateLimits(config({ authRateLimit: { ...config().authRateLimit, login: { max: 987654.5, windowMs: 1 } } })));
    expect(err.message).not.toContain('987654');
  });
});
