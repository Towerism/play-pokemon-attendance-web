import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from './client';

// The upgrade for calendar feeds (ADR-0016): a database at the tournament-leases migration, with rows in it, is
// migrated to the current schema. The change is additive, so every row must survive.

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const LAST_BEFORE_CALENDAR = '0022_tournament_leases';

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
const run = (sql: string, ...params: unknown[]) => database.sqlite.prepare(sql).run(...params);

function user(username: string, role: 'owner' | 'professor') {
  return run(`insert into app_user (username, password_hash, role, created_at) values (?, 'x', ?, 1760000000)`, username, role)
    .lastInsertRowid as number;
}

function feed(kind: 'public' | 'user', userId: number | null, hash: string) {
  run(
    `insert into calendar_feed (league_id, kind, user_id, token_sha256, hint, created_at) values ('default', ?, ?, ?, 'ppa_cal_…abcd', 1760000000)`,
    kind,
    userId,
    hash,
  );
}

beforeEach(() => {
  database = openDatabase(':memory:');
  previous = migrationsUpTo(LAST_BEFORE_CALENDAR);
  migrateDatabase(database.db, previous);
});
afterEach(() => {
  database.close();
  rmSync(previous, { recursive: true, force: true });
});

describe('upgrade for calendar feeds', () => {
  it('keeps every user and adds empty calendar tables', () => {
    user('organizer', 'owner');
    user('misty', 'professor');
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select username from app_user order by id')).toEqual([{ username: 'organizer' }, { username: 'misty' }]);
    expect(rows('select * from calendar_feed')).toEqual([]);
    expect(rows('select * from calendar_snapshot')).toEqual([]);
    expect(rows('pragma foreign_key_check')).toEqual([]);
  });
});

describe('calendar_feed', () => {
  let owner: number;
  let misty: number;

  beforeEach(() => {
    migrateDatabase(database.db, MIGRATIONS_DIR);
    owner = user('organizer', 'owner');
    misty = user('misty', 'professor');
  });

  it('allows one public feed per league', () => {
    feed('public', null, 'a');
    expect(() => feed('public', null, 'b')).toThrow(/UNIQUE/);
  });

  it('allows one user feed per user per league, and feeds for different users', () => {
    feed('user', owner, 'a');
    feed('user', misty, 'b');
    expect(() => feed('user', misty, 'c')).toThrow(/UNIQUE/);
  });

  it('keeps each secret digest unique', () => {
    feed('user', owner, 'same');
    expect(() => feed('user', misty, 'same')).toThrow(/UNIQUE/);
  });

  it('requires a user on a user feed and none on the public feed', () => {
    expect(() => feed('user', null, 'a')).toThrow(/CHECK/);
    expect(() => feed('public', owner, 'b')).toThrow(/CHECK/);
  });
});
