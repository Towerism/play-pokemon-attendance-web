import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from './client';

// The move of the M3 TDF import onto the encrypted archive (ADR-0012): a database
// at the last migration that staged players in tdf_upload_player is migrated.

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const LAST_WITH_STAGED_PLAYERS = '0010_staff_batch';

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

const rows = (sql: string) => database.sqlite.prepare(sql).all() as Record<string, unknown>[];
const run = (sql: string) => database.sqlite.prepare(sql).run();

beforeEach(() => {
  database = openDatabase(':memory:');
  previous = migrationsUpTo(LAST_WITH_STAGED_PLAYERS);
  migrateDatabase(database.db, previous);
});
afterEach(() => {
  database.close();
  rmSync(previous, { recursive: true, force: true });
});

describe('upgrade to the TDF archive', () => {
  beforeEach(() => {
    run(`insert into player (player_id, display_name, first_seen_at) values ('42', 'Ash K', 1760000000)`);
    run(`insert into session_draft (id, league_id, session_date, status) values (1, 'default', '2026-10-14', 'draft')`);
    run(`insert into tdf_upload (id, draft_id, filename, sha256, tournament_name, tournament_date, player_count, status, created_at, committed_at)
         values (1, 1, 'done.tdf', 'aaa', 'Cup', '2026-10-14', 1, 'committed', 1760000000, 1760000100),
                (2, 1, 'pending.tdf', 'bbb', 'Cup', '2026-10-14', 1, 'pending', 1760000200, null)`);
    run(`insert into tdf_upload_player (upload_id, player_id, name) values (1, '42', 'Ash K'), (2, '42', 'Ash K')`);
    run(`insert into session_player (draft_id, player_id, source, tdf_upload_id) values (1, '42', 'tdf', 1)`);
    run(`insert into sighting (league_id, player_id, session_date, kind) values ('default', '42', '2026-10-14', 'tdf')`);
  });

  it('keeps a committed import, with no archived file, and its session players and sightings', () => {
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select id, filename, sha256, status, tdf_file_id from tdf_upload')).toEqual([
      { id: 1, filename: 'done.tdf', sha256: 'aaa', status: 'committed', tdf_file_id: null },
    ]);
    expect(rows('select player_id, source, tdf_upload_id from session_player')).toEqual([{ player_id: '42', source: 'tdf', tdf_upload_id: 1 }]);
    expect(rows('select player_id, kind from sighting')).toEqual([{ player_id: '42', kind: 'tdf' }]);
  });

  it('drops pending previews, which had only staged players to commit from, and the staging table', () => {
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows(`select id from tdf_upload where status = 'pending'`)).toEqual([]);
    expect(rows(`select name from sqlite_master where name = 'tdf_upload_player'`)).toEqual([]);
    expect(rows(`select name from sqlite_master where name = 'tdf_file'`)).toEqual([{ name: 'tdf_file' }]);
  });
});
