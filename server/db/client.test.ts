import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from './client';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('openDatabase', () => {
  it('creates missing parent dirs and opens SQLite in WAL mode with foreign keys on', () => {
    const { sqlite, close } = openDatabase(join(dir, 'nested', 'app.db'));

    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBeGreaterThan(0);
    close();
  });

  it('close() checkpoints the WAL so a stopped container leaves a self-contained app.db', () => {
    const path = join(dir, 'app.db');
    const { sqlite, close } = openDatabase(path);
    sqlite.exec('create table t (x)');
    sqlite.exec('insert into t values (1)');
    close();

    expect(sqlite.open).toBe(false);
    // Nothing left to replay: a file-level backup of app.db alone is complete.
    expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
    const copy = new Database(path, { readonly: true });
    expect(copy.prepare('select count(*) n from t').get()).toEqual({ n: 1 });
    copy.close();
  });
});

describe('migrateDatabase', () => {
  it('applies the migrations and is a no-op on the next boot', () => {
    const { sqlite, db, close } = openDatabase(join(dir, 'app.db'));

    migrateDatabase(db, MIGRATIONS_DIR);
    migrateDatabase(db, MIGRATIONS_DIR);

    const tables = sqlite
      .prepare("select name from sqlite_master where type = 'table' and name = 'app_user'")
      .all();
    expect(tables).toHaveLength(1);
    close();
  });
});
