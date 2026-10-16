import { type AddressInfo, createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { canBind, nextPort, portBlock } from '../server/ports';

// Server-test ports come from a block per test worker, below every OS's ephemeral range,
// so no `listen(0)` (the fake Pokémon servers) and no other worker can take one (#142).

describe('the port block of a test worker', () => {
  it.each([
    ['1', 20_100],
    ['69', 26_900],
    ['70', 20_000],
    ['200', 26_000],
  ])('gives Vitest worker %s the block at %i, inside 20000–26999', (id, first) => {
    const block = portBlock({ VITEST_POOL_ID: id });

    expect(block).toMatchObject({ first, size: 100 });
    expect(block.first + block.size - 1).toBeLessThanOrEqual(26_999);
  });

  it.each([
    ['0', 27_000],
    ['3', 27_300],
    ['20', 27_000],
  ])('gives Playwright worker %s the block at %i, inside 27000–28999', (index, first) => {
    expect(portBlock({ TEST_PARALLEL_INDEX: index })).toMatchObject({ first, size: 100 });
  });

  it('gives anything else the block at 29000', () => {
    expect(portBlock({})).toMatchObject({ first: 29_000, size: 100 });
  });
});

describe('handing out ports', () => {
  const free = async () => true;

  it('gives the ports of the block in turn, wrapping around after the last', async () => {
    const block = portBlock({});
    const ports: number[] = [];
    for (let i = 0; i < 102; i++) ports.push(await nextPort(block, free));

    expect(ports.slice(0, 3)).toEqual([29_000, 29_001, 29_002]);
    expect(ports.slice(98)).toEqual([29_098, 29_099, 29_000, 29_001]);
  });

  it('skips a port something else holds', async () => {
    const block = portBlock({});
    const held = new Set([29_000, 29_001]);

    expect(await nextPort(block, async (port) => !held.has(port))).toBe(29_002);
    expect(await nextPort(block, free)).toBe(29_003);
  });

  it('gives up once every port of the block is held, naming the block', async () => {
    await expect(nextPort(portBlock({}), async () => false)).rejects.toThrow('every port in 29000–29099 is in use');
  });

  it('never gives the same port to two calls running at once', async () => {
    const block = portBlock({});
    const slowlyFree = () => new Promise<boolean>((r) => setImmediate(() => r(true)));

    const ports = await Promise.all([nextPort(block, slowlyFree), nextPort(block, slowlyFree)]);

    expect(new Set(ports).size).toBe(2);
  });
});

describe('checking a port', () => {
  it('says a port is taken while a socket listens on it, and free once it closes', async () => {
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
    const { port } = holder.address() as AddressInfo;

    expect(await canBind(port)).toBe(false);
    await new Promise((r) => holder.close(r));
    expect(await canBind(port)).toBe(true);
  });
});
