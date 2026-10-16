import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, client, runToExit, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };

/** A body sent as one streamed chunk: fetch sends it with `Transfer-Encoding: chunked` and no `Content-Length`. */
function chunked(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe('an /api body without a Content-Length', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;
  beforeAll(async () => {
    server = await startServer();
    browser = client(server.url);
    const res = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } });
    expect(res.status).toBe(200);
  });
  afterAll(() => server.dispose());

  it('is refused with 411 before the route reads it, keeping the security headers and the request id', async () => {
    const res = await browser.request('/api/regulars/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chunked(JSON.stringify([{ name: 'Ash Ketchum', player_id: '0012345' }])),
      duplex: 'half',
    } as RequestInit);

    expect(res.status).toBe(411);
    expect(await res.json()).toMatchObject({ statusCode: 411, message: 'Send the request with a Content-Length header.' });
    expect(res.headers.get('x-request-id')).toMatch(/\S/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');

    const regulars = await browser.request('/api/regulars');
    expect(await regulars.json()).toMatchObject({ regulars: [] });
  });

  it('leaves the TDF preview to its own length rule', async () => {
    const res = await browser.request('/api/sessions/2026-10-10/tdf', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chunked(JSON.stringify({ tdf: '<tournament/>' })),
      duplex: 'half',
    } as RequestInit);

    expect(res.status).toBe(411);
    expect(await res.json()).toMatchObject({ message: 'Content-Length is required.' });
  });
});

describe('a rate-limit setting the limiter refuses, by a path the launcher does not check', () => {
  const limit = (name: string) => `Invalid rate limit (NUXT_${name}_MAX / NUXT_${name}_WINDOW_MS, or their NITRO_ or JSON-object override): `;

  it.each([
    ['NITRO_AUTH_RATE_LIMIT_LOGIN_MAX', '0', limit('AUTH_RATE_LIMIT_LOGIN')],
    ['NITRO_AUTH_RATE_LIMIT_SETUP_WINDOW_MS', '0', limit('AUTH_RATE_LIMIT_SETUP')],
    ['NITRO_INTEGRATION_RATE_LIMIT_MAX', '0', limit('INTEGRATION_RATE_LIMIT')],
    ['NITRO_TRUSTED_PROXIES', 'not-an-ip', 'NUXT_TRUSTED_PROXIES has an invalid entry "not-an-ip"'],
  ])('fails startup for %s=%j with exit code 1, before the database opens, naming the setting', async (name, value, message) => {
    const { code, output } = await runToExit({ [name]: value });
    expect(code).toBe(1);
    expect(output).toContain(message);
    expect(output).not.toMatch(/setup code/i);
  });
});
