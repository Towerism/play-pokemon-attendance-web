import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Builds the production output once per run (`npm run build`). Set
 * TEST_SKIP_BUILD=1 to reuse an existing `.output/` while iterating on tests.
 */
export default function setup() {
  if (process.env.TEST_SKIP_BUILD === '1' && existsSync('.output/launcher.mjs')) return;
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
}
