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
  /** Staff edits close then (start + 90 days); null when the start is unknown. */
  readonly editableUntil: Date | null;
}

export interface TournamentDetails extends Tournament {
  /** Holds the fixed `organizer` role; never assignable as staff on this tournament. */
  readonly organizerPlayerId: PlayerId;
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
