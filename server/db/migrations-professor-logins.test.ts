import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from './client';

// The upgrade to professor logins (ADR-0015 §9): a database built at the last migration before it, with an account,
// connections and a league binding in it, is migrated to the current schema. The app opens its database with foreign
// keys on, as here, so a table rebuilt in the wrong order would cascade-delete rows this checks.

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const LAST_BEFORE_PROFESSOR_LOGINS = '0019_skipped_while_unknown';

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

function account(username: string) {
  database.sqlite.prepare(`insert into app_user (username, password_hash, created_at) values (?, 'hash', 1760000000)`).run(username);
}

function connection(id: number, playerId: string | null) {
  database.sqlite
    .prepare(
      `insert into pokemon_connection (id, professor_player_id, professor_name, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at)
       values (?, ?, ?, ?, ?, 'connected', 1760000000, 1760003600)`,
    )
    .run(id, playerId, playerId && `Prof ${playerId}`, `sub-${id}`, Buffer.from(`sealed-${id}`));
}

function bind(connectionId: number, canSubmit: boolean) {
  database.sqlite
    .prepare(
      `insert into league_upstream (league_id, connection_id, activity_group_id, activity_group_name, activity_group_display_id, activity_group_can_submit)
       values ('default', ?, 'group-1', 'Card Shop', 'L5012', ?)`,
    )
    .run(connectionId, Number(canSubmit));
}

beforeEach(() => {
  database = openDatabase(':memory:');
  previous = migrationsUpTo(LAST_BEFORE_PROFESSOR_LOGINS);
  migrateDatabase(database.db, previous);
});
afterEach(() => {
  database.close();
  rmSync(previous, { recursive: true, force: true });
});

describe('upgrade to professor logins', () => {
  it('makes the setup account the owner, active and not yet signed in under the new release', () => {
    account('organizer');
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select username, role, removed_at, last_sign_in_at from app_user')).toEqual([
      { username: 'organizer', role: 'owner', removed_at: null, last_sign_in_at: null },
    ]);
  });

  it('makes only the lowest-id account the owner if there were ever more', () => {
    account('first');
    account('second');
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select username, role from app_user order by id')).toEqual([
      { username: 'first', role: 'owner' },
      { username: 'second', role: 'professor' },
    ]);
  });

  it('gives every connection to the owner, keeping its id and sealed token so the token still opens on its row', () => {
    account('organizer');
    connection(3, '0012345');
    connection(7, '0067890');
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select id, professor_player_id, user_id, claimed_from_user_id, claimed_at, refresh_token_ciphertext from pokemon_connection order by id')).toEqual([
      { id: 3, professor_player_id: '0012345', user_id: 1, claimed_from_user_id: null, claimed_at: null, refresh_token_ciphertext: Buffer.from('sealed-3') },
      { id: 7, professor_player_id: '0067890', user_id: 1, claimed_from_user_id: null, claimed_at: null, refresh_token_ciphertext: Buffer.from('sealed-7') },
    ]);
  });

  it('seeds the bound connection a member that can submit, as before, and every other connection unknown, none checked yet', () => {
    account('organizer');
    connection(1, '0012345');
    connection(2, '0067890');
    bind(2, true);
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select connection_id, league_id, status, can_submit, checked_at from league_membership order by connection_id')).toEqual([
      { connection_id: 1, league_id: 'default', status: 'unknown', can_submit: 0, checked_at: null },
      { connection_id: 2, league_id: 'default', status: 'member', can_submit: 1, checked_at: null },
    ]);
  });

  it("keeps a bound connection's refusal to submit", () => {
    account('organizer');
    connection(1, '0012345');
    bind(1, false);
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select status, can_submit from league_membership')).toEqual([{ status: 'member', can_submit: 0 }]);
  });

  it("keeps the league's activity group, no longer naming a connection", () => {
    account('organizer');
    connection(1, '0012345');
    bind(1, true);
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select * from league_upstream')).toEqual([
      { league_id: 'default', activity_group_id: 'group-1', activity_group_name: 'Card Shop', activity_group_display_id: 'L5012' },
    ]);
  });

  it('carries over an unidentified v1 connection as the owner’s, unknown', () => {
    account('organizer');
    connection(1, null);
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select id, user_id from pokemon_connection')).toEqual([{ id: 1, user_id: 1 }]);
    expect(rows('select status from league_membership')).toEqual([{ status: 'unknown' }]);
  });

  it('migrates an install that never finished setup', () => {
    migrateDatabase(database.db, MIGRATIONS_DIR);
    expect(rows('select * from app_user')).toEqual([]);
    expect(rows('select * from league_membership')).toEqual([]);
  });

  it('leaves no foreign key broken and drops the temporary copy', () => {
    account('organizer');
    connection(1, '0012345');
    connection(2, '0067890');
    bind(1, true);
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('pragma foreign_key_check')).toEqual([]);
    expect(rows("select name from sqlite_master where name in ('__binding', '__new_league_upstream', '__new_pokemon_connection')")).toEqual([]);
  });

  describe('after the upgrade', () => {
    beforeEach(() => {
      account('organizer');
      connection(1, '0012345');
      bind(1, true);
      migrateDatabase(database.db, MIGRATIONS_DIR);
    });

    it('allows exactly one owner', () => {
      expect(() =>
        database.sqlite.prepare(`insert into app_user (username, password_hash, role, created_at) values ('other', 'h', 'owner', 1)`).run(),
      ).toThrow(/UNIQUE/);
      database.sqlite.prepare(`insert into app_user (username, password_hash, role, created_at) values ('prof', 'h', 'professor', 1)`).run();
    });

    it('makes a new account a professor unless told otherwise', () => {
      database.sqlite.prepare(`insert into app_user (username, password_hash, created_at) values ('prof', 'h', 1)`).run();
      expect(rows(`select role from app_user where username = 'prof'`)).toEqual([{ role: 'professor' }]);
    });

    it("keeps the league chosen when its connection goes, and forgets that connection's membership", () => {
      database.sqlite.prepare('delete from pokemon_connection where id = 1').run();
      expect(rows('select activity_group_id from league_upstream')).toEqual([{ activity_group_id: 'group-1' }]);
      expect(rows('select * from league_membership')).toEqual([]);
    });

    it('refuses a connection for a user who does not exist', () => {
      expect(() =>
        database.sqlite
          .prepare(
            `insert into pokemon_connection (professor_player_id, user_id, ptc_user_id, refresh_token_ciphertext, status, connected_at, last_refreshed_at)
             values ('0099999', 42, 'sub', x'00', 'connected', 1, 1)`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
    });

    it('drops the columns the league no longer keeps', () => {
      expect(columns('league_upstream')).toEqual(['league_id', 'activity_group_id', 'activity_group_name', 'activity_group_display_id']);
    });
  });
});
