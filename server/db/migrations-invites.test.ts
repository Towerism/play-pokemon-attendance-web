import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from './client';

// The upgrade for invites and the Discord channel (ADR-0015 §6–§8): a database at the professor-logins migration, with
// integration tokens in it, is migrated to the current schema. Every change is additive, so every row must survive.

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
const LAST_BEFORE_INVITES = '0020_professor_logins';

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

function token(label: string) {
  database.sqlite
    .prepare(`insert into integration_token (league_id, label, token_hash, token_hint, created_by, created_at) values ('default', ?, ?, 'ppa_int_…abcd', 'organizer', 1760000000)`)
    .run(label, `hash-${label}`);
}

beforeEach(() => {
  database = openDatabase(':memory:');
  previous = migrationsUpTo(LAST_BEFORE_INVITES);
  migrateDatabase(database.db, previous);
});
afterEach(() => {
  database.close();
  rmSync(previous, { recursive: true, force: true });
});

describe('upgrade for invites and the Discord channel', () => {
  it('keeps every integration token, each allowed to read the day', () => {
    token('Genie');
    token('Spreadsheet');
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(rows('select label, scopes, token_hash from integration_token order by id')).toEqual([
      { label: 'Genie', scopes: 'integrations:read', token_hash: 'hash-Genie' },
      { label: 'Spreadsheet', scopes: 'integrations:read', token_hash: 'hash-Spreadsheet' },
    ]);
    expect(columns('integration_token')).not.toContain('scope');
  });

  it('adds the reset proof, invites and outbound messages, with every foreign key satisfied', () => {
    database.sqlite.prepare(`insert into app_user (username, password_hash, role, created_at) values ('organizer', 'hash', 'owner', 1760000000)`).run();
    migrateDatabase(database.db, MIGRATIONS_DIR);

    expect(columns('app_user')).toContain('reverify_required_at');
    expect(columns('app_invite')).toEqual([
      'id',
      'league_id',
      'secret_hash',
      'secret_hint',
      'label',
      'for_player_id',
      'for_user_id',
      'created_by',
      'created_at',
      'expires_at',
      'revoked_at',
      'accepted_at',
      'accepted_user_id',
      'message_id',
      'delivery',
    ]);
    expect(columns('outbound_message')).toEqual([
      'id',
      'league_id',
      'player_id',
      'text',
      'topic',
      'ref',
      'link_label',
      'link_ciphertext',
      'status',
      'status_reason',
      'attempts',
      'next_attempt_at',
      'created_by',
      'created_at',
      'expires_at',
      'delivered_at',
      'handled_at',
    ]);
    expect(rows('select username from app_user')).toEqual([{ username: 'organizer' }]);
    expect(rows('pragma foreign_key_check')).toEqual([]);
  });

  it('refuses two invites with one secret', () => {
    migrateDatabase(database.db, MIGRATIONS_DIR);
    const insert = database.sqlite.prepare(
      `insert into app_invite (league_id, secret_hash, secret_hint, created_by, created_at, expires_at) values ('default', 'same', 'ppa_inv_…abcd', 'organizer', 1, 2)`,
    );
    insert.run();
    expect(() => insert.run()).toThrow(/UNIQUE/);
  });
});
