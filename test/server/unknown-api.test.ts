import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, client, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse battery' };

/** A JSON 404 from the error handler, never the SPA shell. */
async function expectJson404(res: Response) {
  const text = await res.text();
  expect(res.status).toBe(404);
  expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  expect(text).not.toMatch(/<!doctype|<html/i);
  expect(JSON.parse(text)).toMatchObject({ statusCode: 404 });
}

/** GET `path` exactly as written, with no URL normalisation. */
function rawGet(baseUrl: string, path: string): Promise<{ status: number; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/`, { path }, (res) => {
      res.resume();
      resolve({ status: res.statusCode!, contentType: res.headers['content-type'] ?? '' });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('unknown /api paths', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;
  beforeAll(async () => {
    server = await startServer();
    browser = client(server.url);
    const res = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } });
    expect(res.status).toBe(200);
  });
  afterAll(() => server.dispose());

  it('answers a JSON 404 without a session', async () => {
    await expectJson404(await fetch(`${server.url}/api/does-not-exist`));
  });

  it('answers a JSON 404 with a session', async () => {
    await expectJson404(await browser.request('/api/does-not-exist'));
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('answers a JSON 404 to %s', async (method) => {
    await expectJson404(await browser.request('/api/does-not-exist', { method, json: {} }));
  });

  it.each([
    '/api/players/123/nope',
    '/api',
    '/api/',
    '/api/does-not-exist?x=1',
    '/api/Settings',
    '/api/integrations/v1/nope',
    '/api/integrations/v2/days/2026-10-14',
  ])('answers a JSON 404 for %s', async (path) => {
    await expectJson404(await browser.request(path));
  });

  // Sent raw: fetch would resolve the dot segments before the server sees them.
  it.each(['/api/%2e%2e/foo', '/api/..%2fsettings'])('never serves the shell for the encoded path %s', async (path) => {
    const res = await rawGet(server.url, path);
    expect([400, 404]).toContain(res.status);
    expect(res.contentType).toMatch(/^application\/json/);
  });

  it('answers a JSON 404 to a method the path does not define, and the path still works', async () => {
    await expectJson404(await browser.request('/api/settings', { method: 'DELETE' }));
    expect((await browser.request('/api/settings')).status).toBe(200);
  });

  it('echoes the request id on the 404', async () => {
    const res = await fetch(`${server.url}/api/does-not-exist`, { headers: { 'x-request-id': 'req-unknown-api' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-request-id')).toBe('req-unknown-api');
  });

  it('still rejects a non-JSON body before routing (415)', async () => {
    const res = await browser.request('/api/does-not-exist', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' });
    expect(res.status).toBe(415);
  });

  describe('routes that must not change', () => {
    it('keeps the nuxt-auth-utils session route', async () => {
      const res = await fetch(`${server.url}/api/_auth/session`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    });

    it('keeps a real route answering 401 without a session', async () => {
      expect((await fetch(`${server.url}/api/regulars`)).status).toBe(401);
    });

    it.each(['/', '/history'])('keeps serving the SPA shell for the page %s', async (path) => {
      const res = await fetch(`${server.url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    });

    it('keeps /healthz', async () => {
      expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    });
  });
});
