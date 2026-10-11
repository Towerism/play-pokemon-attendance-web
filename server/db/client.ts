import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenDatabase {
  sqlite: Database.Database;
  db: Db;
  /** Checkpoints the WAL and closes the file (graceful shutdown, ADR-0006). */
  close(): void;
}

/** Opens (creating if needed) the app database with the pragmas ADR-0002 relies on. */
export function openDatabase(path: string): OpenDatabase {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    close() {
      if (!sqlite.open) return;
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
      sqlite.close();
    },
  };
}

export function migrateDatabase(db: Db, migrationsFolder: string): void {
  migrate(db, { migrationsFolder });
}
