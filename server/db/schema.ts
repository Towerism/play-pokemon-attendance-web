import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

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

/**
 * A Play! Pokémon league. v1 runs one league, seeded as `default` by the
 * migration; M4 binds it to the upstream activity group.
 */
export const league = sqliteTable('league', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

/** Every player ID that ever entered the system (architecture §5). Names belong to the player, not the league. */
export const player = sqliteTable('player', {
  /** Pokémon Player ID as TEXT: leading zeros survive. */
  playerId: text('player_id').primaryKey(),
  /** Empty until a name is known. */
  displayName: text('display_name').notNull().default(''),
  firstSeenAt: integer('first_seen_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** A player known to a league. "Regular" is a flag here, not a separate list. */
export const playerMembership = sqliteTable(
  'player_membership',
  {
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    playerId: text('player_id')
      .notNull()
      .references(() => player.playerId),
    isRegular: integer('is_regular', { mode: 'boolean' }).notNull().default(false),
    /** Set when the player became a regular; null while not a regular. */
    regularSince: integer('regular_since', { mode: 'timestamp' }),
    notes: text('notes'),
  },
  (t) => [primaryKey({ columns: [t.leagueId, t.playerId] })],
);

/** The attendance list being prepared for one league night. */
export const sessionDraft = sqliteTable(
  'session_draft',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    /** `YYYY-MM-DD` in the league timezone. */
    sessionDate: text('session_date').notNull(),
    /** Upstream play-session GUID, resolved at submission time (M5). */
    playSessionId: text('play_session_id'),
    status: text('status', { enum: ['draft', 'submitting', 'submitted', 'partial', 'failed'] })
      .notNull()
      .default('draft'),
  },
  (t) => [unique('session_draft_league_date_unique').on(t.leagueId, t.sessionDate)],
);

/** A non-regular player listed for a session. */
export const sessionPlayer = sqliteTable(
  'session_player',
  {
    draftId: integer('draft_id')
      .notNull()
      .references(() => sessionDraft.id, { onDelete: 'cascade' }),
    playerId: text('player_id')
      .notNull()
      .references(() => player.playerId),
    source: text('source', { enum: ['tdf', 'manual'] }).notNull(),
    /** The TDF upload that listed the player (M3). */
    tdfUploadId: integer('tdf_upload_id'),
  },
  (t) => [primaryKey({ columns: [t.draftId, t.playerId] })],
);

/** Evidence that a player attended a session; curation metrics come from these (ADR-0005). */
export const sighting = sqliteTable(
  'sighting',
  {
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    playerId: text('player_id')
      .notNull()
      .references(() => player.playerId),
    sessionDate: text('session_date').notNull(),
    kind: text('kind', { enum: ['tdf', 'manual', 'upstream_existing'] }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.leagueId, t.playerId, t.sessionDate, t.kind] }),
    index('sighting_league_date_idx').on(t.leagueId, t.sessionDate),
  ],
);
