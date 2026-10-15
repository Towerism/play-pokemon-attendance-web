import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, client, logRecords, runToExit, setupCodeFrom, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };

/** `Content-Security-Policy` as directive → sources. */
function csp(res: Response): Map<string, string[]> {
  const header = res.headers.get('content-security-policy') ?? '';
  return new Map(
    header
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name!, sources]),
  );
}

const EXPECTED_CSP: Record<string, string[]> = {
  'default-src': ["'self'"],
  'base-uri': ["'none'"],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'script-src-attr': ["'none'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'manifest-src': ["'self'"],
};

const EXPECTED_HEADERS: Record<string, string> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'x-dns-prefetch-control': 'off',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
  'permissions-policy': 'camera=(), display-capture=(), fullscreen=(), geolocation=(), microphone=()',
};

function expectSecurityHeaders(res: Response) {
  const policy = csp(res);
  for (const [directive, sources] of Object.entries(EXPECTED_CSP)) {
    expect(policy.get(directive), directive).toEqual(sources);
  }
  const scriptSrc = policy.get('script-src') ?? [];
  expect(scriptSrc[0]).toBe("'self'");
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(scriptSrc).not.toContain("'unsafe-eval'");
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value);
  }
  expect(res.headers.get('x-powered-by')).toBeNull();
  expect(res.headers.get('cross-origin-embedder-policy')).toBeNull();
  expect(res.headers.get('access-control-allow-origin')).toBeNull();
}

describe('security headers', () => {
  describe('plain-HTTP LAN install (no site URL)', () => {
    let server: TestServer;
    beforeAll(async () => {
      server = await startServer();
    });
    afterAll(() => server.dispose());

    it('sends the CSP and allows each inline script only by its nonce', async () => {
      const res = await fetch(`${server.url}/login`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expectSecurityHeaders(res);

      const scriptSrc = csp(res).get('script-src')!;
      const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(([, attrs, body]) => {
        const type = /\btype="([^"]*)"/i.exec(attrs!)?.[1]?.toLowerCase();
        const executable = type === undefined || type === 'text/javascript' || type === 'module';
        return executable && !/\bsrc=/i.test(attrs!) && body!.trim() !== '';
      });
      expect(inline.length).toBeGreaterThan(0);
      for (const [, attrs] of inline) {
        const nonce = /\bnonce="([^"]+)"/i.exec(attrs!)?.[1];
        expect(nonce, `inline script without a nonce: <script${attrs}>`).toBeDefined();
        expect(scriptSrc).toContain(`'nonce-${nonce}'`);
      }
    });

    it('uses a fresh nonce per response', async () => {
      const nonceOf = async () => csp(await fetch(`${server.url}/login`)).get('script-src')!.find((s) => s.startsWith("'nonce-"));
      const [a, b] = [await nonceOf(), await nonceOf()];
      expect(a).toBeDefined();
      expect(a).not.toBe(b);
    });

    it('references only same-origin resources from the HTML shell', async () => {
      const html = await (await fetch(`${server.url}/login`)).text();
      const urls = [...html.matchAll(/\b(?:src|href)="([^"]*)"/gi)].map((m) => m[1]!);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url, url).toMatch(/^(\/(?!\/)|\.\/|#|data:)/);
    });

    it.each([
      ['GET', '/healthz', 200],
      ['GET', '/api/players', 401],
      ['GET', '/api/does-not-exist', 404],
      ['POST', '/api/auth/login', 400],
    ])('puts the same headers on %s %s (%i)', async (method, path, status) => {
      const res = await fetch(`${server.url}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      expect(res.status).toBe(status);
      expectSecurityHeaders(res);
    });

    it('puts the same headers on the built JS assets', async () => {
      const html = await (await fetch(`${server.url}/login`)).text();
      const asset = /\bsrc="(\/_nuxt\/[^"]+\.js)"/.exec(html)?.[1];
      expect(asset).toBeDefined();
      const res = await fetch(`${server.url}${asset}`);
      expect(res.status).toBe(200);
      expectSecurityHeaders(res);
    });

    it('sends no HSTS and no upgrade-insecure-requests over plain HTTP', async () => {
      for (const path of ['/login', '/healthz']) {
        const res = await fetch(`${server.url}${path}`);
        expect(res.headers.get('strict-transport-security')).toBeNull();
        expect(csp(res).has('upgrade-insecure-requests')).toBe(false);
      }
    });

    it('answers a cross-origin preflight without any CORS grant', async () => {
      const res = await fetch(`${server.url}/api/players`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });

    it('still prints the setup code to the log', () => {
      expect(() => setupCodeFrom(server.logs())).not.toThrow();
    });
  });

  it('keeps HSTS off and the CSP upgrade off for an http:// site URL', async () => {
    const server = await startServer({ env: { NUXT_PUBLIC_SITE_URL: 'http://tower:3000' } });
    try {
      const res = await fetch(`${server.url}/login`);
      expect(res.headers.get('strict-transport-security')).toBeNull();
      expect(csp(res).has('upgrade-insecure-requests')).toBe(false);
    } finally {
      await server.dispose();
    }
  });

  it('turns on HSTS (180 days, no subdomains) and the CSP upgrade for an https:// site URL', async () => {
    const server = await startServer({ env: { NUXT_PUBLIC_SITE_URL: 'https://ppa.example.com' } });
    try {
      for (const path of ['/login', '/healthz', '/api/players']) {
        const res = await fetch(`${server.url}${path}`);
        expect(res.headers.get('strict-transport-security'), path).toBe('max-age=15552000');
        expect(csp(res).get('upgrade-insecure-requests'), path).toEqual([]);
        expectSecurityHeaders(res);
      }
    } finally {
      await server.dispose();
    }
  });
});

describe('auth rate limits', () => {
  const login = (s: TestServer, json: unknown = { username: 'nobody', password: 'wrong password' }, headers: Record<string, string> = {}) =>
    client(s.url).request('/api/auth/login', { method: 'POST', json, headers });

  it('refuses the request after max logins with 429, a code and Retry-After', async () => {
    const server = await startServer({ env: { NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '3' } });
    try {
      for (let i = 0; i < 3; i++) expect((await login(server)).status).toBe(401);
      const res = await login(server);
      expect(res.status).toBe(429);
      const retryAfter = Number(res.headers.get('retry-after'));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(900);
      const body = await res.json();
      expect(body).toMatchObject({ statusCode: 429, data: { code: 'rate_limited', retryAfterSeconds: retryAfter } });
      expectSecurityHeaders(res);
    } finally {
      await server.dispose();
    }
  });

  it('counts successful logins too, and sets no session once limited', async () => {
    const server = await startServer({ env: { NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '2', NUXT_AUTH_RATE_LIMIT_SETUP_MAX: '5' } });
    try {
      const setup = await client(server.url).request('/api/auth/setup', {
        method: 'POST',
        json: { setupCode: setupCodeFrom(server.logs()), ...OWNER },
      });
      expect(setup.status).toBe(200);

      expect((await login(server, OWNER)).status).toBe(200);
      expect((await login(server, OWNER)).status).toBe(200);
      const browser = client(server.url);
      const res = await browser.request('/api/auth/login', { method: 'POST', json: OWNER });
      expect(res.status).toBe(429);
      expect(browser.cookie).toBe('');
    } finally {
      await server.dispose();
    }
  });

  it('refuses before validating the body once limited', async () => {
    const server = await startServer({ env: { NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '1' } });
    try {
      expect((await login(server)).status).toBe(401);
      expect((await login(server, {})).status).toBe(429);
    } finally {
      await server.dispose();
    }
  });

  it('gives setup its own counter, separate from login', async () => {
    const server = await startServer({ env: { NUXT_AUTH_RATE_LIMIT_SETUP_MAX: '2', NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '3' } });
    try {
      const setup = () =>
        client(server.url).request('/api/auth/setup', { method: 'POST', json: { setupCode: 'WXYZ-2345', ...OWNER } });
      expect((await setup()).status).toBe(403);
      expect((await setup()).status).toBe(403);
      expect((await setup()).status).toBe(429);
      expect((await login(server)).status).toBe(401);
    } finally {
      await server.dispose();
    }
  });

  it('defaults to 10 logins and 5 setups per 15 minutes', async () => {
    const server = await startServer();
    try {
      for (let i = 0; i < 10; i++) expect((await login(server)).status).toBe(401);
      const limited = await login(server);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(840);

      const setup = () =>
        client(server.url).request('/api/auth/setup', { method: 'POST', json: { setupCode: 'WXYZ-2345', ...OWNER } });
      for (let i = 0; i < 5; i++) expect((await setup()).status).toBe(403);
      expect((await setup()).status).toBe(429);
    } finally {
      await server.dispose();
    }
  });

  it('ignores forwarded headers from an untrusted peer (a direct LAN client)', async () => {
    const server = await startServer({ env: { NUXT_TRUSTED_PROXIES: 'none', NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '2' } });
    try {
      const statuses = [];
      for (let i = 1; i <= 3; i++) {
        const res = await login(server, undefined, {
          'x-forwarded-for': `10.0.0.${i}`,
          'x-real-ip': `10.0.1.${i}`,
          forwarded: `for=10.0.2.${i}`,
        });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([401, 401, 429]);
    } finally {
      await server.dispose();
    }
  });

  it.each([
    ['unset', undefined],
    ['empty, as Unraid passes a blank field', ''],
    ['whitespace', '   '],
  ])('keys each client by X-Forwarded-For behind a trusted proxy (NUXT_TRUSTED_PROXIES %s)', async (_name, trusted) => {
    const env: Record<string, string> = { NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '2' };
    if (trusted !== undefined) env.NUXT_TRUSTED_PROXIES = trusted;
    const server = await startServer({ env });
    try {
      // The test client connects from 127.0.0.1: it plays Caddy on the same box.
      const statuses = [];
      for (const xff of ['192.168.1.20', '192.168.1.20', '192.168.1.21', '192.168.1.20']) {
        statuses.push((await login(server, undefined, { 'x-forwarded-for': xff })).status);
      }
      expect(statuses).toEqual([401, 401, 401, 429]);
    } finally {
      await server.dispose();
    }
  });

  it('limits nothing else, even for a client that used up both limits', async () => {
    const server = await startServer({ env: { NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '1', NUXT_AUTH_RATE_LIMIT_SETUP_MAX: '1' } });
    try {
      const browser = client(server.url);
      expect((await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } })).status).toBe(200);
      expect((await login(server)).status).toBe(401);
      expect((await login(server)).status).toBe(429);
      expect((await client(server.url).request('/api/auth/setup', { method: 'POST', json: { setupCode: 'WXYZ-2345', ...OWNER } })).status).toBe(429);

      const statuses = new Set<number>();
      for (let i = 0; i < 50; i++) statuses.add((await fetch(`${server.url}/healthz`)).status);
      for (let i = 0; i < 50; i++) statuses.add((await fetch(`${server.url}/api/auth/setup`)).status);
      for (let i = 0; i < 20; i++) statuses.add((await browser.request('/api/players')).status);
      expect(statuses).toEqual(new Set([200]));
    } finally {
      await server.dispose();
    }
  });

  it.each([
    ['NUXT_AUTH_RATE_LIMIT_LOGIN_MAX', '0', /NUXT_AUTH_RATE_LIMIT_LOGIN_MAX/],
    ['NUXT_AUTH_RATE_LIMIT_LOGIN_MAX', 'abc', /NUXT_AUTH_RATE_LIMIT_LOGIN_MAX/],
    ['NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS', '-5', /NUXT_AUTH_RATE_LIMIT_SETUP_WINDOW_MS/],
    // 2^53 + 1: whole digits, but not a safe integer, so the limiter couldn't use it.
    ['NUXT_AUTH_RATE_LIMIT_LOGIN_MAX', '9007199254740993', /NUXT_AUTH_RATE_LIMIT_LOGIN_MAX must be a whole number from 1 to 9007199254740991/],
    ['NUXT_TRUSTED_PROXIES', '10.0.0.0/33', /NUXT_TRUSTED_PROXIES.*"10\.0\.0\.0\/33"/],
    ['NUXT_TRUSTED_PROXIES', 'not-an-ip', /NUXT_TRUSTED_PROXIES.*"not-an-ip"/],
  ])('fails startup for %s=%j and says why', async (name, value, message) => {
    const { code, output } = await runToExit({ [name]: value });
    expect(code).not.toBe(0);
    expect(output).toMatch(message);
  });

  it.each(['none', '10.0.0.5, 2001:db8::/32'])('starts with NUXT_TRUSTED_PROXIES=%j', async (value) => {
    const server = await startServer({ env: { NUXT_TRUSTED_PROXIES: value } });
    await server.dispose();
  });
});

describe('refusals keep request-scoped headers and add no logging of their own', () => {
  it('returns the request id on a 429 and a 413, and only the http logger reports them', async () => {
    const server = await startServer({ env: { NUXT_LOG_FORMAT: 'json', NUXT_LOG_LEVEL: 'debug', NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '1' } });
    try {
      const browser = client(server.url);
      await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } });

      const loginWith = (id: string) =>
        client(server.url).request('/api/auth/login', { method: 'POST', json: OWNER, headers: { 'x-request-id': id } });
      expect((await loginWith('rl-first')).status).toBe(200);
      const limited = await loginWith('rl-limited');
      expect(limited.status).toBe(429);
      expect(limited.headers.get('x-request-id')).toBe('rl-limited');
      expectSecurityHeaders(limited);

      const tooBig = await browser.request('/api/regulars/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': 'too-big' },
        body: `"${'a'.repeat(2 * 1024 * 1024)}"`,
      });
      expect(tooBig.status).toBe(413);
      expect(tooBig.headers.get('x-request-id')).toBe('too-big');
      expectSecurityHeaders(tooBig);

      // Wait for both request lines, then check nothing but the http logger spoke for these requests.
      for (const id of ['rl-limited', 'too-big']) {
        await expect.poll(() => logRecords(server.logs()).filter((r) => r.reqId === id && r.status !== undefined).length).toBe(1);
        const scopes = new Set(logRecords(server.logs()).filter((r) => r.reqId === id).map((r) => r.scope));
        expect(scopes, id).toEqual(new Set(['http']));
      }
    } finally {
      await server.dispose();
    }
  });
});

describe('request size limit', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;
  beforeAll(async () => {
    server = await startServer();
    browser = client(server.url);
    await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } });
  });
  afterAll(() => server.dispose());

  const post = (path: string, bytes: number) =>
    browser.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A JSON string of exactly `bytes` bytes.
      body: `"${'a'.repeat(bytes - 2)}"`,
    });

  it('refuses a JSON body over 2 MiB with 413, keeping the security headers', async () => {
    const res = await post('/api/regulars/import', 2 * 1024 * 1024 + 1);
    expect(res.status).toBe(413);
    expectSecurityHeaders(res);
  });

  it('lets a 2 MiB body through to validation', async () => {
    const res = await post('/api/regulars/import', 2 * 1024 * 1024);
    expect(res.status).toBe(400);
  });

  it('leaves the TDF preview route to its own, larger limit', async () => {
    const res = await post('/api/sessions/2026-10-10/tdf', 3 * 1024 * 1024);
    expect(res.status).not.toBe(413);
  });
});
