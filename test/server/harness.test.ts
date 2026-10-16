import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from './harness';

// #142: when another process holds the port, the app can't listen, and a health check
// answered by that process must not pass for the app having started.

let squatter: Server | undefined;
afterEach(async () => {
  await new Promise((r) => squatter?.close(r) ?? r(undefined));
  squatter = undefined;
});

describe('starting the server', () => {
  it('refuses a port another server holds, even one that answers the health check', async () => {
    const port = await squat();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true);

    await expect(startServer({ port })).rejects.toThrow(new RegExp(`server on port ${port} did not start: .*EADDRINUSE`, 's'));
  });

  it("keeps the caller's data dir when a start fails, so a restart that collides loses nothing", async () => {
    const port = await squat();
    const dataDir = mkdtempSync(join(tmpdir(), 'ppa-kept-'));
    try {
      await expect(startServer({ port, dataDir })).rejects.toThrow(/EADDRINUSE/);

      expect(existsSync(join(dataDir, 'app.db'))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("listens on a port from this worker's block, below the range listen(0) draws from", async () => {
    const server = await startServer();
    try {
      const port = Number(new URL(server.url).port);
      expect(port).toBeGreaterThanOrEqual(20_000);
      expect(port).toBeLessThanOrEqual(26_999);
      await expect(server.waitForLog(new RegExp(`Listening on http://127\\.0\\.0\\.1:${port}\\n`))).resolves.toBeTruthy();
    } finally {
      await server.dispose();
    }
  });
});

/** Holds a port with a server that answers every request, `/healthz` included, with 200. */
async function squat(): Promise<number> {
  squatter = createServer((_req, res) => res.writeHead(200).end('ok'));
  await new Promise<void>((r) => squatter!.listen(0, '127.0.0.1', r));
  return (squatter.address() as AddressInfo).port;
}
