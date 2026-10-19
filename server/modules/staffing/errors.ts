export type StaffingErrorCode =
  /** Not one of the roles play-tools offers staff (`organizer` included). */
  | 'unknown_role'
  /** Not one of this league's tournaments on that date. */
  | 'unknown_tournament'
  /** The tournament is past its edit window: no staff changes. */
  | 'tournament_locked'
  /** The tournament's organizer can never be its staff (ADR-0007 decision 9). */
  | 'organizer_cannot_staff'
  /** The player already has another role on this tournament: one person, one role. */
  | 'player_already_staffed'
  /** Play-tools already lists the player on this tournament (`details.how`). */
  | 'already_listed'
  /** No league chosen in Settings, so the league's tournaments are unknown. */
  | 'league_not_selected'
  /** No such assignment on that date. */
  | 'not_found'
  /** The tournament has no staff assignments, live or removed, for a staff job to apply. */
  | 'nothing_to_apply'
  /** No connected professor organizes the tournament: only its organizer may log its staff (#75). */
  | 'organizer_not_connected'
  /** The tournament's organizer is connected but needs a reconnect (`details.professorPlayerId`). */
  | 'needs_reconnect'
  /** Another user holds the organizer's connection, or nobody can tell who organizes it (ADR-0015 §4; `details.professorPlayerId`). */
  | 'not_your_connection';

export class StaffingError extends Error {
  override name = 'StaffingError';
  constructor(
    readonly code: StaffingErrorCode,
    message: string,
    readonly details: { how?: 'player' | 'staff'; organizerPlayerId?: string; professorPlayerId?: string } = {},
  ) {
    super(message);
  }
}
