/**
 * Spike S6: turns a capture of the play-tools Staff tab into committed
 * contract fixtures. The capture is either the organizer's DevTools HAR or
 * the calls `pnpm spike:s6-live probe` recorded.
 *
 *   pnpm spike:s6 ~/Downloads/play-tools.har
 *   pnpm spike:s6 spikes/.secrets/raw/s6-live.json
 *
 * Keep a HAR outside the repo and delete it afterwards: it holds a live
 * bearer token. Only API-host calls are kept, headers and cookies are never
 * read, and nothing is written if any original id survives sanitisation.
 * Review the diff for anything personal before committing.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { heading, run } from './lib/cli';
import { loadCalls, sanitizeCalls } from './lib/har';

const OUT_DIR = join(import.meta.dirname, '..', 'server/modules/pokemon/adapters/play-tools/__fixtures__/s6');

run(async () => {
  // Several captures are sanitised in one pass, so ids stay consistent across them.
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error('Usage: pnpm spike:s6 <capture.har | spikes/.secrets/raw/s6-*.json> [...]');
  const { calls, leaks } = sanitizeCalls(files.flatMap((f) => loadCalls(JSON.parse(readFileSync(f, 'utf8')))));
  if (leaks.length) throw new Error(`${leaks.length} original value(s) survived sanitisation; nothing written`);

  heading('S6 calls');
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  calls.forEach((c, i) => {
    const slug = c.path.replace(/^\/services\//, '').replace(/[0-9a-f-]{36}/g, '{id}').replace(/[^\w{}]+/g, '_').replace(/^_|_$/g, '');
    const name = `${String(i + 1).padStart(2, '0')}.${c.method}.${slug}.json`;
    writeFileSync(join(OUT_DIR, name), JSON.stringify(c, null, 2) + '\n');
    const q = Object.keys(c.query).length ? `?${new URLSearchParams(c.query)}` : '';
    console.log(`  ${c.status} ${c.method.padEnd(6)} ${c.path}${q}`);
  });
  console.log(`\nWrote ${calls.length} call(s) to ${OUT_DIR}. Inspect them (\`git diff\`) before committing.`);
});
