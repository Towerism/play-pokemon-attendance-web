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

  /** All player attendance records for a session, pages followed to exhaustion. */
  listAttendance(groupId: string, sessionId: string): Promise<AttendanceRecord[]>;

  /**
   * Adds players in one `_bulk` call. Callers chunk (≤ 50) and space calls
   * (≥ 15 s); the adapter does not. Players already present upstream are
   * reported as `alreadyPresent` if the API says so (spike S4), otherwise as
   * `accepted`; reconciliation via `listAttendance` is the source of truth.
   */
  addAttendanceBulk(groupId: string, sessionId: string, playerIds: readonly PlayerId[]): Promise<BulkResult>;

  removeAttendance(groupId: string, sessionId: string, recordId: string): Promise<void>;
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
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
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
}

export interface BulkResult {
  readonly accepted: readonly PlayerId[];
  readonly alreadyPresent: readonly PlayerId[];
  readonly failed: readonly { playerId: PlayerId; error: string }[];
}
