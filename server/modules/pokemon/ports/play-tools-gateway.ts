import type { PlayerId } from '../../../../shared/types/ids';

/**
 * PlayToolsGateway port (architecture §4.3). The domain sees only these
 * types; Pokémon's JSON shapes stay inside the play-tools adapter.
 *
 * Every method may throw `PokemonUpstreamError`.
 */
export interface PlayToolsGateway {
  /** The connected organizer's leagues (activity groups of type `league`; the `personal` group is left out). */
  listLeagues(): Promise<League[]>;

  /**
   * Who the connected account is: the player id owning its `personal` activity group (never a league's owner,
   * who is the store owner), and the professor's name when upstream offers one.
   */
  getProfessorProfile(): Promise<ProfessorProfile>;

  /**
   * Play sessions whose start falls in `[range.from, range.to)`. Pages are
   * followed to exhaustion. `statuses` are queried in order and the call
   * short-circuits on the first status that yields a match (§4.4).
   */
  listPlaySessions(
    groupId: string,
    range: DateRange,
    statuses?: readonly PlaySessionStatus[],
  ): Promise<PlaySession[]>;

  /**
   * Every attendance record for a session, any role, pages followed to
   * exhaustion. Staff records (e.g. the session creator's hidden organizer
   * record, S4) are included: upstream refuses to add a participant twice.
   */
  listAttendance(groupId: string, sessionId: string): Promise<AttendanceRecord[]>;

  /**
   * Adds players in one `_bulk` call. Callers chunk (≤ 50) and space calls
   * (≥ 15 s); the adapter does not. The call is all-or-nothing upstream
   * (S4): a `rejected` batch added nobody. A 5xx throws `unavailable`; the
   * caller then reconciles by re-reading.
   * @throws TypeError for a player id that is not digits only, before calling upstream
   */
  addAttendanceBulk(groupId: string, sessionId: string, playerIds: readonly PlayerId[]): Promise<BulkResult>;

  /**
   * Deletes one attendance record (undo). `not_found` when play-tools no
   * longer has it: someone removed it already.
   * @throws TypeError for a record id that could change the request path, before calling upstream
   */
  removeAttendance(groupId: string, sessionId: string, recordId: string): Promise<'removed' | 'not_found'>;

  // Tournaments and staff (M8, ADR-0007; contract from spike S6). Tournaments are their own
  // resource, separate from play sessions. Ids are checked before any call: a malformed
  // tournament id, record id, player id or role throws TypeError.

  /**
   * Every tournament the connected account organizes, in any activity group, newest first
   * upstream, returned oldest first. With `range`: only those starting in `[from, to)`, so
   * undated ones are left out. Cancelled, deleted and invalidated tournaments never appear.
   */
  listTournaments(range?: DateRange): Promise<Tournament[]>;

  /** One tournament with its organizer. A tournament play-tools doesn't have throws `not_found`. */
  getTournament(tournamentId: string): Promise<TournamentDetails>;

  /** Everyone on a tournament, players and staff (the organizer record too), every page. */
  listTournamentParticipants(tournamentId: string): Promise<TournamentParticipant[]>;

  /** The roles play-tools offers staff, in its order (judge first). Never `organizer`. */
  listStaffRoles(): readonly StaffRole[];

  /**
   * Assigns one staffer. Callers must have just read the participants and details: the app
   * never sends a player id the tournament lists, or its organizer (ADR-0007 decisions 8 and 9).
   * A 5xx throws `unavailable` with the outcome unknown; the caller re-reads, never resends blind.
   */
  assignStaff(tournamentId: string, assignment: { playerId: PlayerId; role: StaffRoleCode }): Promise<StaffAssignResult>;

  /** Changes the role of a staff record (only ever one this app created). */
  changeStaffRole(tournamentId: string, recordId: string, role: StaffRoleCode): Promise<'changed' | 'not_found'>;

  /** Removes a staff record (only ever one this app created). */
  unassignStaff(tournamentId: string, recordId: string, playerId: PlayerId): Promise<'removed' | 'not_found'>;

  // Tournament lifecycle and results (M9, ADR-0010, ADR-0011; contract from spike S8 part 2).
  // Inputs are checked before any call: a malformed id, display id, country, product, category, name,
  // contact or date throws TypeError. Writes are never retried; a 5xx, a network failure or a write timeout
  // throws `unavailable`, and the write may have landed: callers re-read. Any other 4xx throws `refused`
  // with play-tools' message. Every error carries `details.upstream` (code, message, correlation id).

  /** Premier series play-tools offers the connected professor for a league. Disabled ones are left out. */
  listSeries(groupId: string): Promise<Series[]>;

  /** Products and their formats (categories) for a country, in play-tools' order. */
  listFormats(country: string): Promise<Format[]>;

  /** The connected professor's venues (address book) for a league and country, the league's own first. */
  listVenues(groupId: string, country: string): Promise<Venue[]>;

  /** Creates a tournament as the connected professor. A 2xx without the new id throws `unexpected_shape` (it may have landed). */
  createTournament(tournament: NewTournament): Promise<{ tournamentId: string }>;

  /** Changes only the given fields; nothing else is sent. A reschedule is a `startsAt` change. */
  editTournament(tournamentId: string, changes: TournamentChanges): Promise<'edited'>;

  /** Cancels a tournament. Whether it was already cancelled is the caller's to see, from a fresh read. */
  cancelTournament(tournamentId: string): Promise<'cancelled'>;

  /** Sends a TDF to play-tools' validation. No errors means it can be confirmed with the returned upload id. */
  validateResults(displayId: string, tdf: string): Promise<{ uploadId: string; errors: ResultsError[] }>;

  /** Confirms a validated TDF for the tournament (its id, not its display id). play-tools then processes it. */
  confirmResults(uploadId: string, tournamentId: string): Promise<'confirmed'>;

  /** Every TDF upload play-tools has for a tournament, rejected and unconfirmed ones included, oldest first. */
  listResultsUploads(displayId: string): Promise<ResultsUpload[]>;
}

export type Product = 'tcg' | 'vg' | 'pgo';

export interface Series {
  readonly id: string;
  readonly name: string;
  readonly product: string;
  /** The formats the series allows. */
  readonly categories: readonly string[];
  /** e.g. `league_cup`, `league_challenge`, `prerelease`. */
  readonly tags: readonly string[];
  readonly playTemplate: string | null;
  /** Country code → when the series may be held there: inclusive `YYYY-MM-DD` dates. */
  readonly windows: Readonly<Record<string, { readonly from: string; readonly to: string }>>;
}

export interface Format {
  readonly product: string;
  readonly categories: readonly string[];
}

export interface Venue {
  readonly id: string;
  readonly name: string | null;
  readonly formattedAddress: string | null;
  readonly country: string | null;
  /** IANA zone, e.g. `America/Chicago`. */
  readonly timeZone: string | null;
}

/** At least one of the two is set. */
export interface Contact {
  readonly email: string | null;
  readonly phone: string | null;
}

export interface Registration {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/** What the organizer sets on a tournament. Optional fields left out are not sent. */
export interface TournamentSettings {
  readonly name: string;
  /** The format, e.g. `tcg_std`. */
  readonly category: string;
  readonly venueId: string;
  readonly startsAt: Date;
  readonly contact: Contact;
  readonly registration?: Registration | null;
  readonly onSiteAdmission?: string | null;
  readonly thirdPartyRegistrationUrl?: string | null;
  readonly details?: string | null;
  readonly eventWebsite?: string | null;
}

export interface NewTournament extends TournamentSettings {
  readonly groupId: string;
  readonly product: Product;
  /** The premier series, or null for a custom event. */
  readonly seriesId: string | null;
}

/** Only the fields that change; at least one. */
export type TournamentChanges = Partial<TournamentSettings>;

export interface ResultsError {
  /** play-tools' code, e.g. `ORGANIZER_ID_MISMATCH`. */
  readonly code: string;
  /** Readable text for the codes play-tools explains; the code itself otherwise. */
  readonly message: string;
  /** play-tools' own detail (it may name player ids), or null. */
  readonly detail: string | null;
}

export interface ResultsUpload {
  readonly uploadId: string;
  /** Confirmed and taken by play-tools. A validation never confirmed, or refused, is false. */
  readonly accepted: boolean;
  readonly errors: readonly ResultsError[];
  readonly uploadedAt: Date;
}

export interface Tournament {
  /** Tournament GUID. */
  readonly id: string;
  readonly name: string | null;
  /** The id people see, e.g. `26-10-900001`. */
  readonly displayId: string | null;
  /** The activity group (league) it belongs to; may be another store's. */
  readonly groupId: string | null;
  /** `tcg` | `vg` | `pgo`. */
  readonly products: readonly string[];
  /** True UTC (`start_date_v2`); null when play-tools has none (older tournaments). */
  readonly startsAt: Date | null;
  /** Upstream status, e.g. `sanctioned`, `complete`. */
  readonly status: string;
  /**
   * Sanctioning state, e.g. `sanctioned`, `approval-pending`, `sanctioning-error`; it stays `sanctioned` once `status`
   * is `complete`. Null when play-tools didn't send it. Optional so callers building a `Tournament` needn't set it.
   */
  readonly applicationState?: string | null;
  /** Staff edits close then (start + 90 days); null when the start is unknown. */
  readonly editableUntil: Date | null;
}

export interface TournamentDetails extends Tournament {
  /** Holds the fixed `organizer` role; never assignable as staff on this tournament. */
  readonly organizerPlayerId: PlayerId;
  /** First and last name as play-tools has them; null when it has neither. */
  readonly organizerName: string | null;
  /** e.g. `sanctioned`, `approval-pending`, `cancelled`. */
  readonly applicationState: string | null;
  /** `pending`, `upload_in_progress`, `completed` or `upload_failed`. */
  readonly activityState: string | null;
  /** The format, e.g. `tcg_std`. */
  readonly category: string | null;
  /** The premier series; null for a custom event. */
  readonly series: { readonly id: string; readonly name: string | null } | null;
  /** Only when play-tools' read names the venue; callers otherwise fall back to the venue list or the league's zone. */
  readonly venue: { readonly id: string | null; readonly timeZone: string | null } | null;
  readonly contact: Contact;
  readonly registration: Registration | null;
  readonly onSiteAdmission: string | null;
  readonly thirdPartyRegistrationUrl: string | null;
  readonly details: string | null;
  readonly eventWebsite: string | null;
}

export interface TournamentParticipant {
  readonly recordId: string;
  readonly playerId: PlayerId;
  /** `organizer`, a staff role (possibly one this app doesn't know), or null for players. */
  readonly role: string | null;
  readonly isStaff: boolean;
  /** `First Last` as upstream shows it; empty when unknown. */
  readonly name: string;
}

export type StaffRoleCode = 'judge' | 'headjudge' | 'scorekeeper' | 'administration' | 'translator';

export interface StaffRole {
  readonly code: StaffRoleCode;
  readonly label: string;
}

export type StaffAssignResult =
  | { readonly status: 'assigned'; readonly recordId: string }
  /**
   * Upstream refused this staffer: `code` without its `op.<namespace>.` prefix, e.g.
   * `missing_certification`, `player_id_must_be_claimed`, `merged_player_id`,
   * `cannot_duplicate_participant` (a backstop only). `suggestedPlayerId` comes with
   * `merged_player_id`: the id play-tools says to use instead. Never switched automatically.
   */
  | { readonly status: 'refused'; readonly code: string; readonly suggestedPlayerId?: PlayerId }
  /** A 400 with no reason for this staffer; callers record it as failed. */
  | { readonly status: 'invalid'; readonly code: string };

export interface ProfessorProfile {
  readonly playerId: PlayerId;
  /** Null when upstream offers no name; the UI shows "Professor <player id>". */
  readonly name: string | null;
}

export interface League {
  /** Activity group GUID. */
  readonly id: string;
  /** The store name (`display_name`), falling back to the display id. */
  readonly name: string;
  /** Short public id, e.g. `L5012`. */
  readonly displayId: string | null;
  /** The organizer may record attendance (`criteria.play_sessions.create_attendance`). */
  readonly canSubmit: boolean;
}

/** Upstream status values (S3): `pending` = scheduled, `complete` = finished. */
export type PlaySessionStatus = 'active' | 'pending' | 'complete';

export interface PlaySession {
  /** Play session GUID. */
  readonly id: string;
  /** e.g. `open_play`. Upstream has no title (S3): label it from type, products and local start time. */
  readonly type: string;
  /** `tcg` | `vg` | `pgo`. */
  readonly products: readonly string[];
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  /** Attendance edits close then (`final_modifiable_datetime`, start + 7 days). */
  readonly editableUntil: Date | null;
  readonly status: PlaySessionStatus;
}

export interface DateRange {
  /** Inclusive. */
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
}

export interface AttendanceRecord {
  readonly recordId: string;
  readonly playerId: PlayerId;
  /** False for staff records (organizer, judge…), which play-tools hides from its player list. */
  readonly isPlayer: boolean;
  /** `First Last` as upstream shows it; empty when unknown. */
  readonly name: string;
}

export type BulkResult =
  /** Every player was added; record ids in request order. */
  | { readonly status: 'added'; readonly records: readonly { playerId: PlayerId; recordId: string }[] }
  /**
   * Upstream refused the batch and added nobody. The listed players are the
   * reason; everyone else was turned away only because the batch was.
   */
  | {
      readonly status: 'rejected';
      readonly alreadyPresent: readonly PlayerId[];
      readonly failed: readonly { playerId: PlayerId; error: string }[];
    };
