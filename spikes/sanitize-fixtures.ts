/**
 * Turns raw spike captures (.secrets/raw/<kind>.<label>.json) into committed
 * contract fixtures (server/modules/pokemon/adapters/play-tools/__fixtures__).
 *
 *   pnpm spike:fixtures
 *
 * `misc.*` captures are never exported. A fixture is refused if any original
 * GUID or player id survives sanitisation. Review the diff before committing.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_SCHEMAS, type FixtureKind } from '../server/modules/pokemon/adapters/play-tools/wire';
import { heading, run } from './lib/cli';
import { reportValidation } from './lib/op';
import { RAW_DIR } from './lib/secrets';
import { Sanitizer, findLeaks } from './lib/sanitize';

export const FIXTURES_DIR = join(import.meta.dirname, '..', 'server/modules/pokemon/adapters/play-tools/__fixtures__');

run(async () => {
  const files = readdirSync(RAW_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('misc.'));
  if (files.length === 0) throw new Error(`No raw captures in ${RAW_DIR}. Run the spikes first.`);
  mkdirSync(FIXTURES_DIR, { recursive: true });

  // One sanitizer across all files keeps ids consistent between fixtures
  // (e.g. a session id in a play-sessions page and in its attendance URL).
  const sanitizer = new Sanitizer();
  heading('sanitize');
  for (const file of files.sort()) {
    const kind = file.split('.')[0] as FixtureKind;
    if (!(kind in FIXTURE_SCHEMAS)) continue;
    const raw = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf8')) as { status: number; body: unknown };
    const out = JSON.stringify({ status: raw.status, body: sanitizer.sanitize(raw.body) }, null, 2) + '\n';
    const leaks = findLeaks(out, sanitizer.originals);
    if (leaks.length) {
      console.log(`  ✗ ${file}: ${leaks.length} original value(s) survived; not written`);
      continue;
    }
    writeFileSync(join(FIXTURES_DIR, file), out);
    console.log(`  ✓ ${file} (HTTP ${raw.status})`);
    if (raw.status < 300) reportValidation(kind, JSON.parse(out).body);
  }
  console.log(`\nWrote to ${FIXTURES_DIR}. Inspect them (\`git diff\`) for anything personal before committing.`);
});
