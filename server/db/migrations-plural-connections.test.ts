import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from './client';

// The upgrade from one league-keyed Pokémon connection to plural professor
// connections (ADR-0008): a database built at the last migration before it,
// with a connection in it, is migrated to the current schema.

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const LAST_SINGLE_CONNECTION = '0008_staff_job';

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

const CIPHERTEXT = Buffer.from('sealed-with-the-league-id');

function legacyConnection(boundTo: { id: string; name: string; displayId: string; canSubmit: boolean } | null) {
  database.sqlite
    .prepare(
      `insert into pokemon_connection (league_id, ptc_user_id, refresh_token_ciphertext, status, status_reason, connected_at, last_refreshed_at,
         activity_group_id, activity_group_name, activity_group_display_id, activity_group_can_submit)
       values ('default', 'sub-1', ?, 'needs_reconnect', 'Pokémon refused the token', 1760000000, 1760003600, ?, ?, ?, ?)`,
    )
    .run(CIPHERTEXT, boundTo?.id ?? null, boundTo?.name ?? null, boundTo?.displayId ?? null, boundTo ? Number(boundTo.canSubmit) : null);
}

const rows = (sql: string) => database.sqlite.prepare(sql).all() as Record<string, unknown>[];

beforeEach(() => {
  database = openDatabase(':memory:');
  previous = migrationsUpTo(LAST_SINGLE_CONNECTION);
  migrateDatabase(database.db, previous);
});
afterEach(() => {
  database.close();
  rmSync(previous, { recursive: true, force: true });
});

describe('upgrade to plural Pokémon connections', () => {
  it('carries the existing connection over, unidentified, with its token, status and timestamps untouched', () => {
    legacyConnection(null);
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select * from pokemon_connection')).toEqual([
      {
        id: 1,
        professor_player_id: null,
        professor_name: null,
        professor_full_name: null,
        ptc_user_id: 'sub-1',
        refresh_token_ciphertext: CIPHERTEXT,
        status: 'needs_reconnect',
        status_reason: 'Pokémon refused the token',
        connected_at: 1760000000,
        last_refreshed_at: 1760003600,
      },
    ]);
    expect(rows('select * from league_upstream')).toEqual([]);
  });

  it("keeps the league's chosen upstream league, now pointing at the carried-over connection", () => {
    legacyConnection({ id: 'group-1', name: 'Card Shop', displayId: 'L5012', canSubmit: true });
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select * from league_upstream')).toEqual([
      {
        league_id: 'default',
        connection_id: 1,
        activity_group_id: 'group-1',
        activity_group_name: 'Card Shop',
        activity_group_display_id: 'L5012',
        activity_group_can_submit: 1,
      },
    ]);
  });

  it('starts empty when nothing was connected', () => {
    migrateDatabase(database.db, MIGRATIONS_DIR);
    expect(rows('select * from pokemon_connection')).toEqual([]);
    expect(rows('select * from league_upstream')).toEqual([]);
  });

  it('keeps earlier submissions, with no professor recorded', () => {
    database.sqlite
      .prepare(
        `insert into submission (league_id, session_date, play_session_id, play_session_label, started_by, started_at, status)
         values ('default', '2026-10-07', 'ps-1', 'Open play', 'organizer', 1760000000, 'succeeded')`,
      )
      .run();
    migrateDatabase(database.db, MIGRATIONS_DIR);
    expect(rows('select session_date, professor_player_id, professor_name from submission')).toEqual([
      { session_date: '2026-10-07', professor_player_id: null, professor_name: null },
    ]);
  });

  it('enforces one connection per professor player id', () => {
    migrateDatabase(database.db, MIGRATIONS_DIR);
    const insert = database.sqlite.prepare(
      `insert into pokemon_connection (professor_player_id, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at)
       values ('0012345', ?, x'00', 'connected', 1, 1)`,
    );
    insert.run('sub-a');
    expect(() => insert.run('sub-b')).toThrow(/UNIQUE/);
  });

  it('forgets the league binding when its connection is deleted', () => {
    legacyConnection({ id: 'group-1', name: 'Card Shop', displayId: 'L5012', canSubmit: true });
    migrateDatabase(database.db, MIGRATIONS_DIR);
    database.sqlite.prepare('delete from pokemon_connection where id = 1').run();
    expect(rows('select * from league_upstream')).toEqual([]);
  });
});
