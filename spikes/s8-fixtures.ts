/**
 * Spike S8 part 2 (#85): turns the `pnpm spike:s8-live` recordings into
 * committed contract fixtures, in one Sanitizer pass so ids stay consistent.
 * TDFs become a summary, and nothing is written if any original id survives,
 * including every real id the run collected in `.secrets/s8-originals.json`.
 *
 *   pnpm spike:s8 spikes/.secrets/raw/s8-*.json
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { heading, run } from './lib/cli';
import { loadCalls, sanitizeCalls } from './lib/har';
import { SECRETS_DIR, readSecretJson } from './lib/secrets';

const OUT_DIR = join(import.meta.dirname, '..', 'server/modules/pokemon/adapters/play-tools/__fixtures__/s8');

run(async () => {
  const files = process.argv.slice(2).sort();
  if (files.length === 0) throw new Error('Usage: pnpm spike:s8 spikes/.secrets/raw/s8-*.json');
  const knownOriginals = readSecretJson<string[]>(join(SECRETS_DIR, 's8-originals.json')) ?? [];
  if (knownOriginals.length === 0) throw new Error('No .secrets/s8-originals.json: run the live steps first');
  const { calls, leaks } = sanitizeCalls(files.flatMap((f) => loadCalls(JSON.parse(readFileSync(f, 'utf8')))), { knownOriginals });
  // The count only: the values are what must not be printed.
  if (leaks.length) throw new Error(`${leaks.length} original value(s) survived sanitisation; nothing written`);

  heading('S8 calls');
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  calls.forEach((c, i) => {
    const slug = c.path
      .replace(/^\/services\//, '')
      .replace(/[0-9a-f-]{36}|[0-9a-f]{32}/g, '{id}')
      .replace(/\d{2}-\d{2}-\d{6}/g, '{display_id}')
      .replace(/[^\w{}]+/g, '_')
      .replace(/^_|_$/g, '');
    const name = `${String(i + 1).padStart(2, '0')}.${c.method}.${slug}.json`;
    writeFileSync(join(OUT_DIR, name), JSON.stringify(c, null, 2) + '\n');
    console.log(`  ${c.status} ${c.method.padEnd(6)} ${c.path}`);
  });
  console.log(`\nWrote ${calls.length} call(s) to ${OUT_DIR}. Read every file before committing.`);
});
