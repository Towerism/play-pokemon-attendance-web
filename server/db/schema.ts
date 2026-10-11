import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Organizer accounts for the app itself (not Pokémon accounts). */
export const appUser = sqliteTable('app_user', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Stored lower-cased; logins are case-insensitive. */
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});
