import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
    squatter = createServer((_req, res) => res.writeHead(200).end('ok'));
    await new Promise<void>((r) => squatter!.listen(0, '127.0.0.1', r));
    const { port } = squatter.address() as AddressInfo;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).ok).toBe(true);

    await expect(startServer({ port })).rejects.toThrow(new RegExp(`server on port ${port} did not start: .*EADDRINUSE`, 's'));
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
