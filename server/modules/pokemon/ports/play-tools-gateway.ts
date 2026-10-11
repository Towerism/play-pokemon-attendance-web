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
