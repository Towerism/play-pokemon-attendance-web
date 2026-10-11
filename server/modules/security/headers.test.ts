import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, isHttpsSite, securityHeaders } from './headers';

describe('isHttpsSite', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['http://tower:3000', false],
    ['https://ppa.example.com', true],
    ['HTTPS://PPA.EXAMPLE.COM', true],
    ['https//broken', false],
    ['not a url', false],
  ])('%j → %s', (siteUrl, expected) => {
    expect(isHttpsSite(siteUrl)).toBe(expected);
  });
});

describe('contentSecurityPolicy', () => {
  it('locks scripts to same-origin with no inline or eval escape hatch', () => {
    const csp = contentSecurityPolicy({ httpsSite: false });
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['upgrade-insecure-requests']).toBe(false);
  });

  it('adds the nonce placeholder when asked, for the HTML shell', () => {
    expect(contentSecurityPolicy({ httpsSite: false, nonce: true })['script-src']).toEqual(["'self'", "'nonce-{{nonce}}'"]);
  });

  it('upgrades insecure requests only on an HTTPS site', () => {
    expect(contentSecurityPolicy({ httpsSite: true })['upgrade-insecure-requests']).toBe(true);
  });
});

describe('securityHeaders', () => {
  it('serializes the CSP and the fixed headers, with no HSTS over plain HTTP', () => {
    const headers = securityHeaders({ httpsSite: false });
    expect(headers['Content-Security-Policy']).toBe(
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'",
    );
    expect(headers).toMatchObject({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Origin-Agent-Cluster': '?1',
      'X-DNS-Prefetch-Control': 'off',
      'X-Permitted-Cross-Domain-Policies': 'none',
      'X-XSS-Protection': '0',
      'Permissions-Policy': 'camera=(), display-capture=(), fullscreen=(), geolocation=(), microphone=()',
    });
    expect(headers).not.toHaveProperty('Strict-Transport-Security');
  });

  it('adds HSTS (180 days, no subdomains, no preload) and the upgrade on an HTTPS site', () => {
    const headers = securityHeaders({ httpsSite: true });
    expect(headers['Strict-Transport-Security']).toBe('max-age=15552000');
    expect(headers['Content-Security-Policy']).toMatch(/; upgrade-insecure-requests$/);
  });
});
