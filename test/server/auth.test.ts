import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };

describe('auth API', () => {
  let server: TestServer;
  let code: string;
  beforeAll(async () => {
    server = await startServer();
    code = setupCodeFrom(server.logs());
  });
  afterAll(() => server.dispose());

  // Order matters inside this block: setup happens once per install.
  describe('POST /api/auth/setup (before any account exists)', () => {
    it('400 with field errors for an invalid body', async () => {
      const res = await client(server.url).request('/api/auth/setup', {
        method: 'POST',
        json: { setupCode: code, username: 'a', password: 'short' },
      });
      expect(res.status).toBe(400);
    });

    it('403 for a wrong setup code, without a session', async () => {
      const browser = client(server.url);
      const res = await browser.request('/api/auth/setup', {
        method: 'POST',
        json: { setupCode: 'WXYZ-2345', ...OWNER },
      });
      expect(res.status).toBe(403);
      expect(browser.cookie).toBe('');
    });

    it('415 for a non-JSON body (blocks cross-site form posts)', async () => {
      const res = await fetch(`${server.url}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ setupCode: code, ...OWNER }),
      });
      expect(res.status).toBe(415);
    });

    it('creates the account and logs the organizer in', async () => {
      const browser = client(server.url);
      const res = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: code, ...OWNER } });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ user: { id: expect.any(Number), username: 'organizer' } });
      expect(JSON.stringify(body)).not.toMatch(/hash|password/i);

      const session = await (await browser.request('/api/_auth/session')).json();
      expect(session).toMatchObject({ user: { username: 'organizer' } });
    });

    it('409 once an account exists, even with the right code', async () => {
      const res = await client(server.url).request('/api/auth/setup', {
        method: 'POST',
        json: { setupCode: code, username: 'intruder', password: 'correct horse' },
      });
      expect(res.status).toBe(409);
      expect(await (await fetch(`${server.url}/api/auth/setup`)).json()).toEqual({ needsSetup: false });
    });
  });

  describe('POST /api/auth/login', () => {
    it('logs in with case-insensitive username and sets an httpOnly, SameSite=Lax, non-Secure cookie on plain HTTP', async () => {
      const res = await client(server.url).request('/api/auth/login', {
        method: 'POST',
        json: { username: 'Organizer', password: OWNER.password },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ user: { id: expect.any(Number), username: 'organizer' } });
      const cookie = res.headers.getSetCookie().join('\n');
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).not.toMatch(/;\s*Secure/i);
    });

    it.each([
      ['a wrong password', { username: 'organizer', password: 'wrong password' }],
      ['an unknown user', { username: 'nobody', password: OWNER.password }],
    ])('401 with the same message for %s', async (_label, creds) => {
      const browser = client(server.url);
      const res = await browser.request('/api/auth/login', { method: 'POST', json: creds });

      expect(res.status).toBe(401);
      expect((await res.json()).message).toBe('Wrong username or password');
      expect(browser.cookie).toBe('');
    });

    it.each([{}, { username: 'organizer' }, { username: 'organizer', password: 'x'.repeat(257) }])(
      '400 for invalid body %j',
      async (json) => {
        const res = await client(server.url).request('/api/auth/login', { method: 'POST', json });
        expect(res.status).toBe(400);
      },
    );
  });

  describe('POST /api/auth/logout', () => {
    it('ends the session', async () => {
      const browser = client(server.url);
      await browser.request('/api/auth/login', { method: 'POST', json: OWNER });

      const res = await browser.request('/api/auth/logout', { method: 'POST' });
      expect(res.status).toBe(204);
      expect(await (await browser.request('/api/_auth/session')).json()).not.toHaveProperty('user');
    });
  });
});

describe('behind an HTTPS reverse proxy (NUXT_PUBLIC_SITE_URL=https://…)', () => {
  it('marks the session cookie Secure', async () => {
    const server = await startServer({ env: { NUXT_PUBLIC_SITE_URL: 'https://attendance.example.com' } });
    try {
      const res = await client(server.url).request('/api/auth/setup', {
        method: 'POST',
        json: { setupCode: setupCodeFrom(server.logs()), ...OWNER },
      });
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie().join('\n')).toMatch(/;\s*Secure/i);
    } finally {
      await server.dispose();
    }
  });
});
