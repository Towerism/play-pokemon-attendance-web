import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * CI runs the Node in `.node-version`; the shipped image runs the Dockerfile's Node.
 * They must be the same version, and at least the floor selfhost-kit requires (24.11).
 */
const KIT_NODE_FLOOR = [24, 11, 0];

const nodeVersion = readFileSync('.node-version', 'utf8').trim();
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  engines: { node: string };
  scripts: { build: string };
  devDependencies: Record<string, string>;
};
const dockerfile = readFileSync('Dockerfile', 'utf8');

const parts = (version: string) => version.split('.').map(Number);
const atLeast = (version: number[], floor: number[]) => {
  for (let i = 0; i < floor.length; i++) {
    const v = version[i] ?? 0;
    if (v !== floor[i]) return v > floor[i]!;
  }
  return true;
};
const major = parts(nodeVersion)[0];

describe('Node toolchain pins', () => {
  it('pins an exact Node version at or above the kit floor', () => {
    expect(nodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(atLeast(parts(nodeVersion), KIT_NODE_FLOOR), `.node-version ${nodeVersion} is below 24.11`).toBe(true);
  });

  it('declares the kit floor in engines, and .node-version satisfies it', () => {
    expect(pkg.engines.node).toBe('>=24.11');
    expect(atLeast(parts(nodeVersion), parts(pkg.engines.node.slice(2)))).toBe(true);
  });

  it.each([
    ['NODE_IMAGE', `node:${nodeVersion}-alpine3.23`],
    ['NODE_SLIM_IMAGE', `node:${nodeVersion}-slim`],
  ])('builds the image on the same Node as CI (%s)', (arg, image) => {
    expect(dockerfile.match(new RegExp(`^ARG ${arg}=(\\S+)$`, 'm'))?.[1]).toBe(image);
  });

  it('bundles the launcher for the same Node major', () => {
    expect(pkg.scripts.build.match(/--target=node(\d+)/)?.[1]).toBe(String(major));
  });

  it('types Node APIs for the same Node major', () => {
    expect(pkg.devDependencies['@types/node']).toMatch(new RegExp(`^\\^${major}\\.`));
  });
});
