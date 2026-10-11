import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, client, runToExit, setupCodeFrom, startServer } from './harness';

describe('a fresh install (empty /data, no env)', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(() => server.dispose());

  it('is healthy and ready', async () => {
    const health = await fetch(`${server.url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const ready = await fetch(`${server.url}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
  });

  it('creates the database and generates both secrets, owner-only, under the data dir', () => {
    expect(statSync(join(server.dataDir, 'app.db')).isFile()).toBe(true);
    for (const file of ['session-password', 'token-vault.key']) {
      expect(statSync(join(server.dataDir, 'secrets', file)).mode & 0o777).toBe(0o600);
    }
  });

  it('prints a setup code to the log, and never a secret', () => {
    expect(setupCodeFrom(server.logs())).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    for (const file of ['session-password', 'token-vault.key']) {
      const secret = readFileSync(join(server.dataDir, 'secrets', file), 'utf8').trim();
      expect(server.logs()).not.toContain(secret);
    }
  });

  it('reports that first-run setup is needed', async () => {
    const res = await fetch(`${server.url}/api/auth/setup`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needsSetup: true });
  });

  it('prints the same setup code again when the setup page opens, so it is at the bottom of the log', async () => {
    const code = setupCodeFrom(server.logs());
    const before = server.logs().length;

    await fetch(`${server.url}/api/auth/setup`);
    await new Promise((r) => setTimeout(r, 200));

    expect(setupCodeFrom(server.logs().slice(before))).toBe(code);
  });
});

describe('restarting the container', () => {
  it('keeps accounts and sessions, and stops offering setup', async () => {
    const first = await startServer();
    const browser = client(first.url);
    await browser.request('/api/auth/setup', {
      method: 'POST',
      json: { setupCode: setupCodeFrom(first.logs()), username: 'organizer', password: 'correct horse' },
    });
    await first.stop();

    const second = await startServer({ dataDir: first.dataDir });
    try {
      expect(second.logs()).not.toMatch(/setup code/i);
      expect(await (await fetch(`${second.url}/api/auth/setup`)).json()).toEqual({ needsSetup: false });
      await new Promise((r) => setTimeout(r, 200));
      expect(second.logs()).not.toMatch(/setup code/i);

      // Same persisted session password → the cookie from before the restart still works.
      const again = client(second.url);
      const session = await fetch(`${second.url}/api/_auth/session`, { headers: { cookie: browser.cookie } });
      expect(await session.json()).toMatchObject({ user: { username: 'organizer' } });

      const login = await again.request('/api/auth/login', {
        method: 'POST',
        json: { username: 'organizer', password: 'correct horse' },
      });
      expect(login.status).toBe(200);
    } finally {
      await second.dispose();
    }
  });
});

describe('SIGTERM (docker stop, Appdata Backup)', () => {
  it('exits promptly and leaves a self-contained app.db (WAL checkpointed)', async () => {
    const server = await startServer();
    try {
      // Write something so the WAL has content.
      await client(server.url).request('/api/auth/setup', {
        method: 'POST',
        json: { setupCode: setupCodeFrom(server.logs()), username: 'organizer', password: 'correct horse' },
      });
      const started = Date.now();
      await server.stop();

      expect(Date.now() - started).toBeLessThan(5_000);
      const wal = join(server.dataDir, 'app.db-wal');
      expect(existsSync(wal) ? statSync(wal).size : 0).toBe(0);
    } finally {
      await server.dispose();
    }
  });
});

describe('startup failures are loud', () => {
  it('refuses to start with a malformed session password, naming the variable only', async () => {
    const { code, output } = await runToExit({ NUXT_SESSION_PASSWORD: 'too-short-secret' });

    expect(code).not.toBe(0);
    expect(output).toContain('NUXT_SESSION_PASSWORD');
    expect(output).not.toContain('too-short-secret');
  });
});
