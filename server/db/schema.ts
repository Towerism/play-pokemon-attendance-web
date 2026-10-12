import { sql } from 'drizzle-orm';
import { blob, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
 * migration; its Pokémon connection binds it to an upstream activity group.
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

/**
 * A `.tdf` previewed for a session, then committed. Only the tournament's name
 * and date are kept; the raw file is discarded after parsing (architecture §9).
 */
export const tdfUpload = sqliteTable(
  'tdf_upload',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    draftId: integer('draft_id')
      .notNull()
      .references(() => sessionDraft.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    /** Of the file's text; re-uploading the same file for the date is a no-op. */
    sha256: text('sha256').notNull(),
    tournamentName: text('tournament_name'),
    tournamentDate: text('tournament_date'),
    playerCount: integer('player_count').notNull(),
    status: text('status', { enum: ['pending', 'committed'] })
      .notNull()
      .default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    committedAt: integer('committed_at', { mode: 'timestamp' }),
  },
  (t) => [unique('tdf_upload_draft_sha256_unique').on(t.draftId, t.sha256)],
);

/** The players a TDF listed (name and ID only), held between preview and commit. */
export const tdfUploadPlayer = sqliteTable(
  'tdf_upload_player',
  {
    uploadId: integer('upload_id')
      .notNull()
      .references(() => tdfUpload.id, { onDelete: 'cascade' }),
    playerId: text('player_id').notNull(),
    /** Empty when the file had no name. */
    name: text('name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.playerId] })],
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

/**
 * The league's curation thresholds (architecture §5), set in Settings. Owned
 * by the metrics module; a league without a row uses the defaults.
 */
export const curationSettings = sqliteTable('curation_settings', {
  leagueId: text('league_id')
    .primaryKey()
    .references(() => league.id),
  /** Promotion candidate: a non-regular with at least this many sightings in the last 8 weeks. */
  promoteMinSightings: integer('promote_min_sightings').notNull(),
  /** Stale regular: no tdf or manual sighting in this many league sessions. */
  staleAfterSessions: integer('stale_after_sessions').notNull(),
});

/**
 * One attempt to bring a play session's upstream attendance up to date
 * (ADR-0004). Retry and resume start a new attempt; the history keeps each.
 * Owned by the submission module, which keys it by league and date instead of
 * reading the sessions module's drafts.
 */
export const submission = sqliteTable(
  'submission',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    sessionDate: text('session_date').notNull(),
    playSessionId: text('play_session_id').notNull(),
    playSessionLabel: text('play_session_label').notNull(),
    /** Organizer username. */
    startedBy: text('started_by').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    status: text('status', { enum: ['planned', 'running', 'succeeded', 'partial', 'failed', 'interrupted'] }).notNull(),
    /** Why the job stopped, when it did not finish. */
    error: text('error'),
    /** The attempt this one retries or resumes. */
    retryOf: integer('retry_of'),
    /**
     * `undo` removes the records another submission added; `clear` removes every player record in the play session (M7).
     * `staff` applies a tournament's staff assignments (M8): `play_session_id` then holds the tournament GUID and
     * `play_session_label` "Staff for <tournament>".
     */
    kind: text('kind', { enum: ['submit', 'undo', 'clear', 'staff'] }).notNull().default('submit'),
    /** For an undo: the submission whose added records it removes. */
    undoOf: integer('undo_of'),
  },
  (t) => [index('submission_league_date_idx').on(t.leagueId, t.sessionDate)],
);

/** Per player: what the submission found or did. `upstream` items are players play-tools had that nobody here asked for. */
export const submissionItem = sqliteTable(
  'submission_item',
  {
    submissionId: integer('submission_id')
      .notNull()
      .references(() => submission.id, { onDelete: 'cascade' }),
    playerId: text('player_id')
      .notNull()
      .references(() => player.playerId),
    origin: text('origin', { enum: ['session', 'regular', 'upstream'] }).notNull(),
    /** `removed` and `already_removed` are the outcomes of an undo, a clear or a staff job; the rest after them only a staff job's. */
    outcome: text('outcome', {
      enum: [
        'pending',
        'added',
        'already_present',
        'failed',
        'skipped',
        'unrequested',
        'removed',
        'already_removed',
        'assigned',
        'already_assigned',
        'already_listed',
        'is_organizer',
        'role_changed',
        'ineligible',
      ],
    }).notNull(),
    error: text('error'),
    /** The upstream attendance record, once known (for undo, M7). */
    recordId: text('record_id'),
    /** Present upstream in a staff role (e.g. the session's organizer), not as a player. */
    asStaff: integer('as_staff', { mode: 'boolean' }).notNull().default(false),
    /** Staff jobs only (M8): the wanted role. */
    role: text('role'),
    /** Staff jobs only: why an item failed, as a code (an upstream refusal code, `tournament_locked`, `local_write_failed`…). */
    errorCode: text('error_code'),
    /** Staff jobs only: the id play-tools says a `merged_player_id` was merged into. A suggestion; never switched to. */
    suggestedPlayerId: text('suggested_player_id'),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.playerId] })],
);

/** Progress, persisted before it is pushed to the browser over SSE. */
export const submissionEvent = sqliteTable(
  'submission_event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    submissionId: integer('submission_id')
      .notNull()
      .references(() => submission.id, { onDelete: 'cascade' }),
    at: integer('at', { mode: 'timestamp_ms' }).notNull(),
    type: text('type').notNull(),
    message: text('message').notNull(),
    done: integer('done').notNull(),
    total: integer('total').notNull(),
  },
  (t) => [index('submission_event_submission_idx').on(t.submissionId, t.id)],
);

/** Per-league lease: one submission at a time (ADR-0004). Renewed while the job runs; an expired lease is free. */
export const submissionLock = sqliteTable('submission_lock', {
  leagueId: text('league_id')
    .primaryKey()
    .references(() => league.id),
  submissionId: integer('submission_id').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * The league's link to play-tools (ADR-0003): whose Pokémon account, which
 * activity group, and the refresh token sealed by the token vault. Owned by
 * the pokemon module.
 */
export const pokemonConnection = sqliteTable('pokemon_connection', {
  leagueId: text('league_id')
    .primaryKey()
    .references(() => league.id),
  /** Access-token `sub`: the OP user id (S5). */
  ptcUserId: text('ptc_user_id').notNull(),
  /** AES-256-GCM blob from the token vault; never leaves the server. */
  refreshTokenCiphertext: blob('refresh_token_ciphertext', { mode: 'buffer' }).notNull(),
  status: text('status', { enum: ['connected', 'needs_reconnect'] }).notNull(),
  /** Why the connection needs a reconnect; null while connected. */
  statusReason: text('status_reason'),
  connectedAt: integer('connected_at', { mode: 'timestamp' }).notNull(),
  lastRefreshedAt: integer('last_refreshed_at', { mode: 'timestamp' }).notNull(),
  /** The upstream activity group this league submits to; null until chosen. */
  activityGroupId: text('activity_group_id'),
  activityGroupName: text('activity_group_name'),
  activityGroupDisplayId: text('activity_group_display_id'),
  /** `criteria.play_sessions.create_attendance` when the group was chosen. */
  activityGroupCanSubmit: integer('activity_group_can_submit', { mode: 'boolean' }),
});

/**
 * Staff the organizer wants on a tournament (ADR-0007): desired state, applied
 * upstream by a staff job. Owned by the staffing module. One live row per
 * (league, tournament, player): one person, one role per tournament.
 */
export const staffAssignment = sqliteTable(
  'staff_assignment',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    /** `YYYY-MM-DD` in the league timezone. */
    sessionDate: text('session_date').notNull(),
    /** Upstream tournament GUID. */
    tournamentId: text('tournament_id').notNull(),
    /** `name · display id` when the assignment was added. */
    tournamentLabel: text('tournament_label').notNull(),
    playerId: text('player_id')
      .notNull()
      .references(() => player.playerId),
    /** The wanted role: a play-tools staff role code, never `organizer`. */
    role: text('role').notNull(),
    state: text('state', { enum: ['pending', 'assigned', 'failed', 'removing'] })
      .notNull()
      .default('pending'),
    /** The upstream staff record, once the assignment reached play-tools (or was found there). */
    recordId: text('record_id'),
    /** The role play-tools holds, while it differs from `role`. */
    appliedRole: text('applied_role'),
    /** When the assignment first reached play-tools. */
    assignedAt: integer('assigned_at', { mode: 'timestamp' }),
    /** Tombstone: the organizer removed it; the next staff job deletes `record_id`. */
    removedAt: integer('removed_at', { mode: 'timestamp' }),
    /** Organizer username. */
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    uniqueIndex('staff_assignment_live_unique')
      .on(t.leagueId, t.tournamentId, t.playerId)
      .where(sql`${t.removedAt} is null`),
    index('staff_assignment_league_date_idx').on(t.leagueId, t.sessionDate),
  ],
);

/**
 * Who has staffed the league's tournaments (ADR-0007 decision 5): the staff
 * list. Seeded from every read of a tournament's staff and from applied
 * assignments. Not attendance evidence (ADR-0005). Owned by the staffing module.
 */
export const staffHistory = sqliteTable(
  'staff_history',
  {
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    tournamentId: text('tournament_id').notNull(),
    playerId: text('player_id')
      .notNull()
      .references(() => player.playerId),
    /** The tournament's start as a league-timezone date; null when play-tools has none. */
    tournamentDate: text('tournament_date'),
    /** The upstream role as text, possibly one the app doesn't offer; never `organizer`. */
    role: text('role').notNull(),
    /** `app` once this app applied or adopted the assignment; it never goes back to `upstream`. */
    source: text('source', { enum: ['app', 'upstream'] }).notNull(),
    recordedAt: integer('recorded_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.leagueId, t.tournamentId, t.playerId] }),
    index('staff_history_league_player_idx').on(t.leagueId, t.playerId),
  ],
);
