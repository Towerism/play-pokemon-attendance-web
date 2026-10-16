import { createServer } from 'node:net';

/**
 * Ports for the servers the tests start (#142). A port the kernel hands out with `listen(0)` and
 * that the harness then frees is open to anyone until the child binds it, and every fake Pokémon
 * server in a parallel test file takes its port with `listen(0)`. So each test worker gets its own
 * block of ports below every OS's ephemeral range (Linux 32768–60999, macOS and Windows 49152+),
 * where `listen(0)` never lands and no other worker looks:
 *
 * - Vitest workers (`VITEST_POOL_ID`, from 1): 20000–26999, 70 blocks;
 * - Playwright workers (`TEST_PARALLEL_INDEX`, from 0): 27000–28999, 20 blocks;
 * - anything else: 29000–29099.
 */
const SIZE = 100;

export interface PortBlock {
  first: number;
  size: typeof SIZE;
}

export function portBlock(env: NodeJS.ProcessEnv): PortBlock {
  if (env.VITEST_POOL_ID !== undefined) return { first: 20_000 + (Number(env.VITEST_POOL_ID) % 70) * SIZE, size: SIZE };
  if (env.TEST_PARALLEL_INDEX !== undefined) return { first: 27_000 + (Number(env.TEST_PARALLEL_INDEX) % 20) * SIZE, size: SIZE };
  return { first: 29_000, size: SIZE };
}

/** Each block's next turn; a fresh `portBlock()` starts again at its first port. */
const turns = new WeakMap<PortBlock, number>();

/**
 * The next port of `block` in turn that `isFree` says nothing holds. Each turn is taken before
 * `isFree` is awaited, so two calls running at once never try the same port.
 */
export async function nextPort(block: PortBlock, isFree: (port: number) => Promise<boolean>): Promise<number> {
  for (let tried = 0; tried < block.size; tried++) {
    const turn = turns.get(block) ?? 0;
    turns.set(block, turn + 1);
    const port = block.first + (turn % block.size);
    if (await isFree(port)) return port;
  }
  throw new Error(`every port in ${block.first}–${block.first + block.size - 1} is in use`);
}

/** Whether a server could listen on `port` on 127.0.0.1 right now (the address the test servers use). */
export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
