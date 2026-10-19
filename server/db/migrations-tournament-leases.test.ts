import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from './client';

// The upgrade for tournament leases (ADR-0015 §5): a database at the invites migration, with submissions in it, is
// migrated to the current schema. The change is additive, so every row must survive.

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const LAST_BEFORE_LEASES = '0021_invites_and_messages';

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
const columns = (table: string) => rows(`pragma table_info(${table})`).map((c) => c.name);
const run = (sql: string, ...params: unknown[]) => database.sqlite.prepare(sql).run(...params);

function submission(label: string) {
  run(
    `insert into submission (league_id, session_date, play_session_id, play_session_label, started_by, started_at, status, kind)
     values ('default', '2026-10-01', 'ps-1', ?, 'organizer', 1760000000, 'succeeded', 'submit')`,
    label,
  );
}

function lease(tournamentId: string, endedAt: number | null) {
  run(
    `insert into tournament_lease (league_id, connection_id, tournament_id, tournament_label, lessee_user_id, granted_by, granted_at, ends_at, ended_at)
     values ('default', 1, ?, 'Cup · 2026-11-07', 2, 'organizer', 1760000000, 1770000000, ?)`,
    tournamentId,
    endedAt,
  );
}

beforeEach(() => {
  database = openDatabase(':memory:');
  previous = migrationsUpTo(LAST_BEFORE_LEASES);
  migrateDatabase(database.db, previous);
});
afterEach(() => {
  database.close();
  rmSync(previous, { recursive: true, force: true });
});

describe('upgrade for tournament leases', () => {
  it('keeps every submission, none of them leased', () => {
    submission('Thursday league');
    submission('Saturday league');
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select play_session_label, lease_id from submission order by id')).toEqual([
      { play_session_label: 'Thursday league', lease_id: null },
      { play_session_label: 'Saturday league', lease_id: null },
    ]);
    expect(rows('pragma foreign_key_check')).toEqual([]);
  });

  it('adds the lease table, allowing one live lease per tournament', () => {
    run(`insert into app_user (username, password_hash, role, created_at) values ('organizer', 'hash', 'owner', 1760000000)`);
    run(`insert into app_user (username, password_hash, role, created_at) values ('misty', 'hash', 'professor', 1760000000)`);
    run(
      `insert into pokemon_connection (user_id, ptc_user_id, professor_player_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at)
       values (1, 'ptc-1', '0099999', x'00', 'connected', 1760000000, 1760000000)`,
    );
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(columns('tournament_lease')).toEqual([
      'id',
      'league_id',
      'connection_id',
      'tournament_id',
      'tournament_label',
      'lessee_user_id',
      'granted_by',
      'granted_at',
      'ends_at',
      'ended_at',
      'end_reason',
      'notice_message_id',
      'notice_delivery',
    ]);
    lease('t-1', 1765000000);
    lease('t-1', null);
    expect(() => lease('t-1', null)).toThrow(/UNIQUE/);
    expect(rows('pragma foreign_key_check')).toEqual([]);
  });

  it('deletes a connection’s leases with it', () => {
    run(`insert into app_user (username, password_hash, role, created_at) values ('organizer', 'hash', 'owner', 1760000000)`);
    run(`insert into app_user (username, password_hash, role, created_at) values ('misty', 'hash', 'professor', 1760000000)`);
    run(
      `insert into pokemon_connection (user_id, ptc_user_id, professor_player_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at)
       values (1, 'ptc-1', '0099999', x'00', 'connected', 1760000000, 1760000000)`,
    );
    migrateDatabase(database.db, MIGRATIONS_DIR);
    lease('t-1', null);

    run('delete from pokemon_connection where id = 1');
    expect(rows('select id from tournament_lease')).toEqual([]);
  });
});
