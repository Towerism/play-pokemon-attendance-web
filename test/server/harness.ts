import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LAUNCHER = resolve('.output/launcher.mjs');

export interface TestServer {
  url: string;
  dataDir: string;
  /** Everything the process wrote to stdout and stderr so far. */
  logs(): string;
  /** SIGTERM and wait for exit; keeps the data dir. */
  stop(): Promise<void>;
  /** Stop and delete the data dir. */
  dispose(): Promise<void>;
}

/**
 * Starts the built app the way the container does (`node .output/launcher.mjs`)
 * with its own data dir, on a free port.
 */
export async function startServer(opts: { env?: Record<string, string>; dataDir?: string } = {}): Promise<TestServer> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'ppa-server-'));
  const port = await freePort();
  let output = '';

  const child = spawn(process.execPath, [LAUNCHER], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      NUXT_DATABASE_PATH: join(dataDir, 'app.db'),
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));

  const server: TestServer = {
    url: `http://127.0.0.1:${port}`,
    dataDir,
    logs: () => output,
    stop: () => stopProcess(child),
    async dispose() {
      await stopProcess(child);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };

  try {
    await waitForHealthy(server.url, child, () => output);
  } catch (err) {
    await server.dispose();
    throw err;
  }
  return server;
}

/** Runs the launcher expecting it to exit (startup failure); resolves with code and output. */
export async function runToExit(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ppa-server-'));
  const child = spawn(process.execPath, [LAUNCHER], {
    env: { PATH: process.env.PATH, PORT: String(await freePort()), NUXT_DATABASE_PATH: join(dataDir, 'app.db'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (d) => (output += d));
  child.stderr!.on('data', (d) => (output += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const code = await new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
  clearTimeout(timer);
  rmSync(dataDir, { recursive: true, force: true });
  return { code, output };
}

async function waitForHealthy(url: string, child: ChildProcess, logs: () => string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}) during startup:\n${logs()}`);
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy:\n${logs()}`);
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((res) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      res();
    });
    child.kill('SIGTERM');
  });
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => res(port));
    });
  });
}

/** Minimal cookie-carrying client for one browser "session". */
export function client(baseUrl: string) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async request(path: string, init: RequestInit & { json?: unknown } = {}) {
      const headers = new Headers(init.headers);
      if (cookie) headers.set('cookie', cookie);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(init.json);
      }
      const res = await fetch(`${baseUrl}${path}`, { ...init, headers, body, redirect: 'manual' });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      return res;
    },
  };
}

export function setupCodeFrom(logs: string): string {
  const match = logs.match(/setup code:?\s*([A-Z2-9]{4}-[A-Z2-9]{4})/i);
  if (!match) throw new Error(`no setup code in logs:\n${logs}`);
  return match[1]!;
}
