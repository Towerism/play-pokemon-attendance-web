import { sql } from 'drizzle-orm';
import { blob, index, integer, primaryKey, sqliteTable, text, unique, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Accounts for the app itself (not Pokémon accounts), owned by the accounts module (ADR-0015 §1): the owner, who set
 * the install up, and professors. Rows are never deleted, so a username keeps meaning one person in history.
 */
export const appUser = sqliteTable(
  'app_user',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Stored lower-cased; logins are case-insensitive. */
    username: text('username').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    /** Exactly one `owner`; read from here on every request, never from the session cookie. */
    role: text('role', { enum: ['owner', 'professor'] })
      .notNull()
      .default('professor'),
    /** Set when the owner removes a professor: they can't sign in, and their next request is refused. */
    removedAt: integer('removed_at', { mode: 'timestamp' }),
    lastSignInAt: integer('last_sign_in_at', { mode: 'timestamp' }),
    /**
     * Set when a professor accepts a password reset link (ADR-0015 §8). Until their next successful Pokémon connect they
     * are held to the waiting room, because a reset link can travel through Discord.
     */
    reverifyRequiredAt: integer('reverify_required_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex('app_user_one_owner').on(t.role).where(sql`${t.role} = 'owner'`)],
);

/**
 * A Play! Pokémon league. v1 runs one league, seeded as `default` by the
 * migration; its Pokémon connection binds it to an upstream activity group.
 */
export const league = sqliteTable('league', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

/**
 * A one-time link the owner mints (ADR-0015 §6, §8): an invite creates a professor; with `for_user_id` set it is a
 * password reset link for that professor. Owned by the accounts module. Only the secret's SHA-256 is kept.
 */
export const appInvite = sqliteTable('app_invite', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  leagueId: text('league_id')
    .notNull()
    .references(() => league.id),
  /** Lowercase hex SHA-256 of the secret, which is never stored. */
  secretHash: text('secret_hash').notNull().unique(),
  /** `ppa_inv_…` plus the secret's last 4 characters. */
  secretHint: text('secret_hint').notNull(),
  /** Display only, e.g. the invitee's Discord name. */
  label: text('label'),
  /** The only Pokémon account the professor this invite creates may connect. */
  forPlayerId: text('for_player_id'),
  /** Set for a password reset link: the professor whose password it sets. */
  forUserId: integer('for_user_id').references(() => appUser.id),
  /** The owner's username. */
  createdBy: text('created_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  acceptedAt: integer('accepted_at', { mode: 'timestamp' }),
  /** The professor it created, or the one it reset. */
  acceptedUserId: integer('accepted_user_id').references(() => appUser.id),
  /** Its Discord message in the messaging module's table, when sent by Discord. No foreign key: that table isn't ours. */
  messageId: integer('message_id'),
  /** What Genie reported, for Settings → Professors; null for a copied link. */
  delivery: text('delivery', { enum: ['sending', 'delivered', 'no_discord_user', 'dm_refused', 'undeliverable', 'expired'] }),
});

/**
 * A direct message for Tournament Genie to deliver on Discord (ADR-0015 §7). Owned by the messaging module, which no
 * other module reads. The link is sealed by the message vault and deleted once the message is final, expired or
 * cancelled; rows are deleted 30 days after they were created, because the text can hold names.
 */
export const outboundMessage = sqliteTable(
  'outbound_message',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    /** Who it is for: Genie finds the Discord user for this player ID. */
    playerId: text('player_id').notNull(),
    /** Plain text, at most 1,800 characters. */
    text: text('text').notNull(),
    /** The sending feature's own name; never sent to Genie. */
    topic: text('topic').notNull(),
    /** The sender's own id for it. */
    ref: text('ref'),
    linkLabel: text('link_label'),
    /** The link's URL, sealed under AAD `outbound_message:<id>`. */
    linkCiphertext: blob('link_ciphertext', { mode: 'buffer' }),
    status: text('status', { enum: ['pending', 'delivered', 'no_discord_user', 'dm_refused', 'undeliverable', 'expired', 'cancelled'] }).notNull(),
    statusReason: text('status_reason'),
    /** Failures Genie reported; the 5th makes the message undeliverable. */
    attempts: integer('attempts').notNull().default(0),
    /** When it may be handed out next: after a hand-out (60 s) or a failure (backoff). */
    nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp' }).notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    deliveredAt: integer('delivered_at', { mode: 'timestamp' }),
    /** When the sender's topic handler ran for its final result; a final row with this null is replayed at boot. */
    handledAt: integer('handled_at', { mode: 'timestamp' }),
  },
  (t) => [index('outbound_message_due_idx').on(t.leagueId, t.status, t.nextAttemptAt), index('outbound_message_created_idx').on(t.createdAt)],
);

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
 * Every `.tdf` the organizer drops, kept whole for bookkeeping (ADR-0012): gzip,
 * then AES-256-GCM with the TDF key, AAD `tdf_file:<league_id>:<sha256>`. Owned
 * by the `tdf-archive` module; no birthdate ever leaves `ciphertext`.
 */
export const tdfFile = sqliteTable(
  'tdf_file',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    /** Of the file's text as stored. */
    sha256: text('sha256').notNull(),
    filename: text('filename').notNull(),
    /** UTF-8 bytes before compression. */
    byteSize: integer('byte_size').notNull(),
    ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
    tournamentName: text('tournament_name'),
    tournamentDate: text('tournament_date'),
    /** The file's `data/id`. */
    tournamentDisplayId: text('tournament_display_id'),
    /** JSON set of `attendance` / `results`; empty while only previewed (expires after a day). */
    keptFor: text('kept_for').notNull().default('[]'),
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [unique('tdf_file_league_sha256_unique').on(t.leagueId, t.sha256)],
);

/**
 * A `.tdf` previewed for a session, then committed. The file itself lives in
 * the encrypted archive (`tdf_file`); commit parses it again from there.
 */
export const tdfUpload = sqliteTable(
  'tdf_upload',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    draftId: integer('draft_id')
      .notNull()
      .references(() => sessionDraft.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    /** Of the file's text as dropped; re-uploading the same file for the date is a no-op. Kept when the row is re-pointed or the file deleted. */
    sha256: text('sha256').notNull(),
    /** The archived file; re-pointed to a corrected copy (ADR-0012), null once the organizer deletes it. */
    tdfFileId: integer('tdf_file_id').references(() => tdfFile.id, { onDelete: 'set null' }),
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
    /** The professor whose Pokémon connection made the upstream calls (ADR-0008); null on attempts from before it. */
    professorPlayerId: text('professor_player_id'),
    /** Their name at the time, when known. */
    professorName: text('professor_name'),
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
     * `play_session_label` "Staff for <tournament>". `staff_import` reads every tournament the account organizes
     * into the staff list (M8): `play_session_id` is '' and `play_session_label` "Staff import". `player_import` reads
     * the same tournaments into the league's players (#35): `play_session_label` "Player import". `tournament_create`
     * creates planned tournaments in play-tools (#92, ADR-0010 decision 5): `play_session_id` is '' and its items are
     * `submission_tournament_item` rows. `tournament_edit` edits (and reschedules) tournaments in play-tools (#93,
     * ADR-0010 decisions 8 and 11), with the same items. `tdf_upload` sends a tournament's TDF to play-tools (#96,
     * ADR-0011): validate, then confirm only if play-tools accepts it; one item.
     */
    kind: text('kind', {
      enum: ['submit', 'undo', 'clear', 'staff', 'staff_import', 'player_import', 'tournament_create', 'tournament_edit', 'tournament_cancel', 'tdf_upload'],
    })
      .notNull()
      .default('submit'),
    /** For an undo: the submission whose added records it removes. */
    undoOf: integer('undo_of'),
    /** A **Create through date…** job (#92): the schedule, and the date it creates through. */
    throughScheduleId: integer('through_schedule_id'),
    throughDate: text('through_date'),
    /**
     * The results upload (`tournament_result_upload`) a `tdf_upload` job sends, or whose Remove-from-staff a `staff`
     * job runs (#96). No FK across modules.
     */
    resultsUploadId: integer('results_upload_id'),
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
    /**
     * `removed` and `already_removed` are the outcomes of an undo, a clear or a staff job; the rest after them up to
     * `ineligible` only a staff job's. `found` and `new_player` are a staff import's: a staffer it found, already known
     * to the league or not.
     */
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
        'found',
        'new_player',
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

/**
 * Per tournament: what a tournament job found or did (ADR-0010 decision 7), in start order. Owned by the submission
 * module; `planned_tournament_id` points into the tournaments module, which it reaches only through its service.
 */
export const submissionTournamentItem = sqliteTable(
  'submission_tournament_item',
  {
    submissionId: integer('submission_id')
      .notNull()
      .references(() => submission.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    plannedTournamentId: integer('planned_tournament_id'),
    /** The upstream guid, once known. */
    tournamentId: text('tournament_id'),
    /** The resolved name and local date. */
    label: text('label').notNull(),
    /**
     * `edited` and `already_applied` are an edit job's (#93); `cancelled` and `already_cancelled` a cancel job's (#94);
     * `processing` through `processing_failed` a `tdf_upload` job's (#96).
     */
    outcome: text('outcome', {
      enum: [
        'pending',
        'created',
        'already_exists',
        'refused',
        'failed',
        'skipped',
        'unknown',
        'date_too_far_past',
        'date_too_far_ahead',
        'edited',
        'already_applied',
        'cancelled',
        'already_cancelled',
        'processing',
        'uploaded',
        'not_accepted',
        'warnings_changed',
        'validate_unknown',
        'processing_failed',
      ],
    }).notNull(),
    /** Written just before the create or edit is sent (#100): boot recovery reads it. */
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    /** Less than 7 days ahead when the job started; the job's `started_by` acknowledged it. */
    shortNotice: integer('short_notice', { mode: 'boolean' }).notNull().default(false),
    errorCode: text('error_code'),
    error: text('error'),
    /** JSON support details (ADR-0010 decision 7): never a token, a request body or player data. */
    support: text('support', { mode: 'json' }),
    /** An edit item's changes in the app's terms (#93): applied over a fresh read when its turn comes. A cancel item's `{confirmed}` (#94). */
    changes: text('changes', { mode: 'json' }),
    /** The organizer an edit or cancel item runs as (ADR-0009). */
    professorPlayerId: text('professor_player_id'),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.position] })],
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

/**
 * Assign staff for every tournament on a date (#76, ADR-0007 update): one `staff` job per tournament,
 * run one after another under one hold of the league's lease. Owned by the submission module.
 */
export const staffBatch = sqliteTable(
  'staff_batch',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    sessionDate: text('session_date').notNull(),
    /** Organizer username. */
    startedBy: text('started_by').notNull(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    status: text('status', { enum: ['running', 'succeeded', 'partial', 'failed', 'interrupted'] }).notNull().default('running'),
  },
  (t) => [index('staff_batch_league_date_status_idx').on(t.leagueId, t.sessionDate, t.status)],
);

/** One tournament of a staff batch, in run order: its job once started, or why it wasn't. */
export const staffBatchItem = sqliteTable(
  'staff_batch_item',
  {
    batchId: integer('batch_id')
      .notNull()
      .references(() => staffBatch.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    tournamentId: text('tournament_id').notNull(),
    /** The tournament's label once its turn read it; its id until then. */
    tournamentLabel: text('tournament_label').notNull(),
    status: text('status', { enum: ['waiting', 'running', 'succeeded', 'partial', 'failed', 'not_started', 'interrupted'] })
      .notNull()
      .default('waiting'),
    submissionId: integer('submission_id').references(() => submission.id),
    refusalCode: text('refusal_code'),
    refusalMessage: text('refusal_message'),
  },
  (t) => [primaryKey({ columns: [t.batchId, t.position] }), unique('staff_batch_item_tournament_uq').on(t.batchId, t.tournamentId)],
);

/**
 * Per-league lease: one submission at a time (ADR-0004). Renewed while the job runs; an expired lease is free.
 * Between a staff batch's jobs `submission_id` holds minus the batch id, so no job of any kind starts in between (#76).
 */
export const submissionLock = sqliteTable('submission_lock', {
  leagueId: text('league_id')
    .primaryKey()
    .references(() => league.id),
  submissionId: integer('submission_id').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * One professor's Pokémon account (ADR-0003, ADR-0008): who it is and the
 * refresh token sealed by the token vault. Owned by the pokemon module.
 */
export const pokemonConnection = sqliteTable('pokemon_connection', {
  /** Also the vault's AAD (`pokemon_connection:<id>`), so a ciphertext only opens on its own row. */
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** The user who completed its connect, the only one who writes to play-tools through it (ADR-0015 §2). */
  userId: integer('user_id')
    .notNull()
    .references(() => appUser.id),
  /** The owner, when a professor took this connection over from them (ADR-0015 §2). */
  claimedFromUserId: integer('claimed_from_user_id').references(() => appUser.id),
  claimedAt: integer('claimed_at', { mode: 'timestamp' }),
  /** The professor's player id; null only for a connection carried over from v1 until its first refresh identifies it. */
  professorPlayerId: text('professor_player_id').unique(),
  /** Null when upstream offers no name. */
  professorName: text('professor_name'),
  /**
   * The professor's full name as play-tools has it, set by the organizer (ADR-0011 decision 8); never written from
   * Pokémon data. Written into a TDF only when the app replaces its organizer. Null until set.
   */
  professorFullName: text('professor_full_name'),
  /** Access-token `sub`: the OP user id (S5). */
  ptcUserId: text('ptc_user_id').notNull(),
  /** AES-256-GCM blob from the token vault; never leaves the server. */
  refreshTokenCiphertext: blob('refresh_token_ciphertext', { mode: 'buffer' }).notNull(),
  status: text('status', { enum: ['connected', 'needs_reconnect'] }).notNull(),
  /** Why the connection needs a reconnect; null while connected. */
  statusReason: text('status_reason'),
  connectedAt: integer('connected_at', { mode: 'timestamp' }).notNull(),
  lastRefreshedAt: integer('last_refreshed_at', { mode: 'timestamp' }).notNull(),
});

/**
 * The league's upstream activity group, chosen by the owner from their own connections' leagues (ADR-0015 §3).
 * Owned by the pokemon module. It names no connection: attendance goes in as whoever submits.
 */
export const leagueUpstream = sqliteTable('league_upstream', {
  leagueId: text('league_id')
    .primaryKey()
    .references(() => league.id),
  activityGroupId: text('activity_group_id').notNull(),
  activityGroupName: text('activity_group_name').notNull(),
  activityGroupDisplayId: text('activity_group_display_id'),
});

/**
 * Whether a connection's Pokémon account is in the league's activity group (ADR-0015 §3), from the last successful
 * read of its leagues. A failed read never changes it. A professor sees the league only while theirs is `member`.
 */
export const leagueMembership = sqliteTable('league_membership', {
  connectionId: integer('connection_id')
    .primaryKey()
    .references(() => pokemonConnection.id, { onDelete: 'cascade' }),
  leagueId: text('league_id')
    .notNull()
    .references(() => league.id),
  status: text('status', { enum: ['member', 'outside', 'unknown'] }).notNull(),
  /** `criteria.play_sessions.create_attendance` for the league; false unless `member`. */
  canSubmit: integer('can_submit', { mode: 'boolean' }).notNull().default(false),
  /** The last successful read; null until one, and again after a connect or a league change resets it. */
  checkedAt: integer('checked_at', { mode: 'timestamp' }),
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

/**
 * Bearer tokens another app reads the integrations API with (#115, ADR-0013): Tournament Genie's day import.
 * Only the SHA-256 of the secret is stored; the secret is shown once. Owned by the integrations module.
 */
export const integrationToken = sqliteTable(
  'integration_token',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    /** What the organizer called it, e.g. "Tournament Genie". */
    label: text('label').notNull(),
    /** Lowercase hex SHA-256 of the secret. */
    tokenHash: text('token_hash').notNull().unique(),
    /** `ppa_int_…` plus the secret's last 4 characters, to tell tokens apart. */
    tokenHint: text('token_hint').notNull(),
    /** Space-separated: `integrations:read` (the day route) and/or `messages:deliver` (the Discord channel; ADR-0015 §7). */
    scopes: text('scopes').notNull().default('integrations:read'),
    /** Organizer username. */
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    /** The last call it authenticated; null until then. */
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  },
  (t) => [index('integration_token_league_idx').on(t.leagueId)],
);

/**
 * One tournament's settings (ADR-0010 decision 3): what a planned tournament is created with, as its organizer.
 * Archived, never deleted. Owned by the tournaments module, as are the tables below.
 */
export const tournamentTemplate = sqliteTable(
  'tournament_template',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    /** ≤ 80; may hold `{month}`, `{year}` and `{date}`. */
    name: text('name').notNull(),
    /** A connected professor: the tournament is created as them (ADR-0009). */
    organizerPlayerId: text('organizer_player_id').notNull(),
    product: text('product', { enum: ['tcg', 'vg', 'pgo'] }).notNull(),
    /** The format, e.g. `tcg_std`. */
    category: text('category').notNull(),
    /** As picked from play-tools' live type list (decision 6). */
    eventType: text('event_type', { enum: ['custom', 'premier'] }).notNull(),
    /** Premier only: part of the series' name, resolved per date against `listSeries`. */
    seriesMatch: text('series_match'),
    /** The organizer's address-book entry. */
    venueId: text('venue_id').notNull(),
    venueLabel: text('venue_label').notNull(),
    venueTimeZone: text('venue_time_zone').notNull(),
    /** Two-letter: series windows and formats are per country. */
    venueCountry: text('venue_country').notNull(),
    /** `HH:MM`, local to the venue. */
    startTime: text('start_time').notNull(),
    /** JSON: `{kind: on_site, opensBeforeMin, closesAfterMin, admission}` or `{kind: third_party, url}`. */
    registration: text('registration', { mode: 'json' }).notNull(),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    details: text('details'),
    eventWebsite: text('event_website'),
    archivedAt: integer('archived_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('tournament_template_league_idx').on(t.leagueId)],
);

/** Templates held together, e.g. a TCG and a VGC Cup on one afternoon (decision 3). Archived, never deleted. */
export const tournamentScaffold = sqliteTable(
  'tournament_scaffold',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    name: text('name').notNull(),
    archivedAt: integer('archived_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('tournament_scaffold_league_idx').on(t.leagueId)],
);

/** One tournament of a scaffold, in order from position 0. Replaced as a whole when the scaffold is edited. */
export const scaffoldSlot = sqliteTable(
  'scaffold_slot',
  {
    scaffoldId: integer('scaffold_id')
      .notNull()
      .references(() => tournamentScaffold.id),
    position: integer('position').notNull(),
    templateId: integer('template_id')
      .notNull()
      .references(() => tournamentTemplate.id),
    /** Days after the scaffold's date, 0–6. */
    dayOffset: integer('day_offset').notNull(),
    /** Overrides the template's start time. */
    startTime: text('start_time'),
  },
  (t) => [primaryKey({ columns: [t.scaffoldId, t.position] })],
);

/** A recurrence for one scaffold (decision 3), planned on read up to its horizon. Archived, never deleted. */
export const tournamentSchedule = sqliteTable(
  'tournament_schedule',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    scaffoldId: integer('scaffold_id')
      .notNull()
      .references(() => tournamentScaffold.id),
    /** JSON, `shared/schedule` `scheduleRuleSchema`. */
    rule: text('rule', { mode: 'json' }).notNull(),
    startsOn: text('starts_on').notNull(),
    endsOn: text('ends_on'),
    /** 1–26. */
    horizonWeeks: integer('horizon_weeks').notNull(),
    /** The last date **Create through date…** covered (#92); display only. */
    createdThrough: text('created_through'),
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    archivedAt: integer('archived_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('tournament_schedule_league_idx').on(t.leagueId)],
);

/**
 * One tournament the organizer wants on one date (decision 3): from a schedule's slot, or a one-off from a
 * template. Desired state: it reaches play-tools only on a click (#92), and then holds the upstream guid.
 */
export const plannedTournament = sqliteTable(
  'planned_tournament',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    /** Null for a one-off. */
    scheduleId: integer('schedule_id').references(() => tournamentSchedule.id),
    slotPosition: integer('slot_position'),
    /** The scaffold's date the row was planned for. */
    occurrenceDate: text('occurrence_date'),
    templateId: integer('template_id')
      .notNull()
      .references(() => tournamentTemplate.id),
    /** In the venue's zone. */
    localDate: text('local_date').notNull(),
    startTime: text('start_time').notNull(),
    /** A series id or `custom`, picked on the row when its match found none or several. */
    seriesOverride: text('series_override'),
    /** JSON: fields set on this row before creation, `localDate` and `startTime` included (decision 11). */
    overrides: text('overrides', { mode: 'json' }).notNull().default({}),
    state: text('state', { enum: ['planned', 'skipped', 'creating', 'created', 'failed', 'cancelled', 'unknown'] })
      .notNull()
      .default('planned'),
    /** The upstream guid once created or adopted. */
    tournamentId: text('tournament_id'),
    /** When a create was last sent (#100). */
    lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp' }),
    /** Skipped while `unknown` (#125): its create may have landed, so it is held, and linked on read. Read only while `skipped`. */
    skippedWhileUnknown: integer('skipped_while_unknown', { mode: 'boolean' }).notNull().default(false),
    displayId: text('display_id'),
    upstreamStatus: text('upstream_status'),
    errorCode: text('error_code'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    uniqueIndex('planned_tournament_occurrence_unique').on(t.scheduleId, t.slotPosition, t.occurrenceDate),
    uniqueIndex('planned_tournament_tournament_unique')
      .on(t.leagueId, t.tournamentId)
      .where(sql`${t.tournamentId} is not null`),
    index('planned_tournament_league_date_idx').on(t.leagueId, t.localDate),
    index('planned_tournament_event_idx').on(t.leagueId, t.templateId, t.localDate),
  ],
);

/**
 * An edit applied across a schedule (decision 11): fields that tournaments of one slot are created with from a
 * date on. Never a date. Written by the edit flow (#93); read when settings are resolved.
 */
export const tournamentScheduleOverride = sqliteTable(
  'tournament_schedule_override',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scheduleId: integer('schedule_id')
      .notNull()
      .references(() => tournamentSchedule.id),
    slotPosition: integer('slot_position').notNull(),
    effectiveFrom: text('effective_from').notNull(),
    /** JSON: the changed settings fields carried over. */
    fields: text('fields', { mode: 'json' }).notNull(),
    /** Organizer username. */
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('tournament_schedule_override_schedule_idx').on(t.scheduleId, t.slotPosition)],
);

/**
 * An event the league must hold every period (ADR-0010 decision 12): a series match × product × cadence, seeded with
 * League Cup quarterly and League Challenge monthly for TCG, VGC and GO. Turned off, never deleted (#95).
 */
export const tournamentRequirement = sqliteTable(
  'tournament_requirement',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    /** Part of play-tools' series name, matched case-insensitively (e.g. `League Cup`). */
    seriesMatch: text('series_match').notNull(),
    product: text('product', { enum: ['tcg', 'vg', 'pgo'] }).notNull(),
    cadence: text('cadence', { enum: ['month', 'quarter'] }).notNull(),
    minCount: integer('min_count').notNull().default(1),
    /** Days before a period's latest date an uncovered period turns at risk. */
    warnDays: integer('warn_days').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('tournament_requirement_league_idx').on(t.leagueId)],
);

/** A period covered by an event the app can't see, e.g. one run by a professor who isn't connected (decision 12). */
export const requirementManualCover = sqliteTable(
  'requirement_manual_cover',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    requirementId: integer('requirement_id')
      .notNull()
      .references(() => tournamentRequirement.id),
    /** The first day of the cadence period, `YYYY-MM-DD` (#102). */
    periodStart: text('period_start').notNull(),
    note: text('note').notNull(),
    /** The username who recorded it. */
    createdBy: text('created_by').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [uniqueIndex('requirement_manual_cover_period_unique').on(t.requirementId, t.periodStart)],
);

/**
 * A tournament's TDF results upload (ADR-0011, #96): one per preview, kept as the attempt's record. The file lives in
 * the encrypted archive; this row holds what the app checked, what the organizer acknowledged and what play-tools
 * answered. Owned by the `tournaments` module.
 */
export const tournamentResultUpload = sqliteTable(
  'tournament_result_upload',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    leagueId: text('league_id')
      .notNull()
      .references(() => league.id),
    /** The play-tools tournament guid. */
    tournamentId: text('tournament_id').notNull(),
    displayId: text('display_id'),
    /** The tournament's name in play-tools at the preview, for labels. */
    tournamentName: text('tournament_name'),
    /** The This week date the file was dropped on. */
    sessionDate: text('session_date').notNull(),
    filename: text('filename').notNull(),
    /** The archived file: as dropped, or the corrected copy (ADR-0011 decision 8); null once the organizer deletes it. */
    tdfFileId: integer('tdf_file_id').references(() => tdfFile.id, { onDelete: 'set null' }),
    /** Of the file as dropped; kept after the file is replaced or deleted. */
    sha256: text('sha256').notNull(),
    playerCount: integer('player_count').notNull(),
    /** The attendance import (`tdf_upload`) previewed from the same drop. No FK across modules. */
    attendanceUploadId: integer('attendance_upload_id'),
    /** `{fromPlayerId, fromName, toPlayerId, toName}` when the app replaced the file's organizer. */
    organizerReplaced: text('organizer_replaced', { mode: 'json' }),
    tournamentIdFilled: integer('tournament_id_filled', { mode: 'boolean' }).notNull().default(false),
    /** `{playerId, playToolsName}` while the organizer's full name is asked for; then null. */
    pendingOrganizer: text('pending_organizer', { mode: 'json' }),
    /** The local checks' warnings (codes, messages, subjects). */
    warnings: text('warnings', { mode: 'json' }).notNull().default([]),
    /** SHA-256 of the warnings' codes and subjects (#101); null only while the full name is asked for. */
    warningsFingerprint: text('warnings_fingerprint'),
    acknowledgedFingerprint: text('acknowledged_fingerprint'),
    acknowledgedBy: text('acknowledged_by'),
    acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }),
    /** The tournament's organizer, whom the job acts as (ADR-0009). */
    professorPlayerId: text('professor_player_id'),
    /** play-tools' `upload_guid`. */
    upstreamUploadId: text('upstream_upload_id'),
    /** play-tools' validation errors: `{code, message, detail}`. */
    upstreamErrors: text('upstream_errors', { mode: 'json' }).notNull().default([]),
    /** Why a `failed` upload failed (`interrupted`, `confirm_not_landed`, `processing_failed`, a block or upstream code). */
    errorCode: text('error_code'),
    state: text('state', {
      enum: ['previewed', 'sending', 'not_accepted', 'warnings_changed', 'validate_unknown', 'processing', 'complete', 'failed'],
    }).notNull(),
    /** Its `tdf_upload` job. No FK across modules. */
    submissionId: integer('submission_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('tournament_result_upload_tournament_idx').on(t.leagueId, t.tournamentId)],
);
