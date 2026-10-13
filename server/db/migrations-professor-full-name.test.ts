import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from './client';

// The professor's full name on the Pokémon connection (ADR-0011 decision 8): a database
// whose connections predate it is migrated.

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const LAST_WITHOUT_FULL_NAME = '0011_tdf_archive';

let database: OpenDatabase;
let previous: string;

/** A copy of the migrations folder whose journal stops at `tag`. */
function migrationsUpTo(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const end = journal.entries.findIndex((e) => e.tag === tag);
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, end + 1) }));
  return dir;
}

beforeEach(() => {
  database = openDatabase(':memory:');
  previous = migrationsUpTo(LAST_WITHOUT_FULL_NAME);
  migrateDatabase(database.db, previous);
});
afterEach(() => {
  database.close();
  rmSync(previous, { recursive: true, force: true });
});

it('keeps every connection as it was, with no full name yet', () => {
  database.sqlite
    .prepare(
      `insert into pokemon_connection (id, professor_player_id, professor_name, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at)
       values (3, '0000222', 'Brock', 'sub-brock', x'0102', 'connected', 1760000000, 1760000100)`,
    )
    .run();

  migrateDatabase(database.db, MIGRATIONS_DIR);

  expect(
    database.sqlite
      .prepare('select id, professor_player_id, professor_name, professor_full_name, hex(refresh_token_ciphertext) as token from pokemon_connection')
      .all(),
  ).toEqual([{ id: 3, professor_player_id: '0000222', professor_name: 'Brock', professor_full_name: null, token: '0102' }]);
});
