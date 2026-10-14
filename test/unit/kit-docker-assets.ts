import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The bin `pnpm exec selfhost-kit` runs, resolved from the repo root so the tests work from any directory. */
const BIN = fileURLToPath(new URL('../../node_modules/.bin/selfhost-kit', import.meta.url));

/**
 * The Docker assets exactly as the image gets them: the kit's own `selfhost-kit docker-assets` bin (the command the
 * Dockerfile runs) copies them into a fresh temp directory. Tests read these copies, never a file in the repo, so
 * they always check the pinned kit version's bytes.
 */
export function copyKitDockerAssets(): { dir: string; path: (name: string) => string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'kit-docker-assets-'));
  const result = spawnSync(BIN, ['docker-assets', dir], { encoding: 'utf8' });
  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`selfhost-kit docker-assets failed (${result.status}): ${result.stderr || result.error?.message}`);
  }
  return {
    dir,
    path: (name) => join(dir, name),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
