export type TournamentsErrorCode =
  /** No such template, scaffold, schedule or planned tournament in this league. */
  | 'not_found'
  /** A template's organizer must be a professor connected to the league (ADR-0009). */
  | 'organizer_not_connected'
  /** A template needs a contact email or phone. */
  | 'contact_required'
  /** A scaffold that isn't archived uses the template (`details.scaffoldIds`). */
  | 'template_in_use'
  /** A schedule that isn't archived uses the scaffold (`details.scheduleIds`). */
  | 'scaffold_in_use'
  | 'unknown_template'
  | 'template_archived'
  | 'unknown_scaffold'
  | 'scaffold_archived'
  /** A planned tournament of that template, date and start already exists (`details.plannedTournamentId`; #100). */
  | 'already_planned'
  /** The planned tournament has reached play-tools or a job holds it (`details.state`). */
  | 'not_editable'
  /** Before the creatable window (today − 2 days, ADR-0010 decision 6). */
  | 'date_too_far_past'
  /** More than 12 months ahead. */
  | 'date_too_far_ahead'
  /** An Upcoming range longer than allowed. */
  | 'invalid_range'
  /** No league chosen in Settings, so play-tools can't be asked for its choices. */
  | 'league_not_selected'
  /** No connected professor with that player id. */
  | 'connection_not_found'
  /** That professor's connection needs a reconnect (`details.professorPlayerId`). */
  | 'needs_reconnect'
  /** A create job takes only `planned`, `failed` or (confirmed) `unknown` rows (`details.plannedTournamentId`, `state`; #92). */
  | 'not_creatable'
  /** An `unknown` row, a create that may have landed, sent without `retryUnknown` (`details.plannedTournamentIds`; #100). */
  | 'retry_not_confirmed'
  /** Rows less than 7 days ahead, sent without `acknowledgeShortNotice` (`details.plannedTournamentIds`; ADR-0010 decision 6). */
  | 'short_notice_not_acknowledged'
  /** **Create through date…** on a paused or archived schedule, or one whose scaffold is archived. */
  | 'schedule_inactive'
  /** More than 60 tournaments in one create job (`details.count`, `suggestedThrough`). */
  | 'too_many_tournaments'
  /** Nothing left to create. */
  | 'nothing_to_create'
  // Edit… (#93, ADR-0010 decisions 8 and 11)
  /** play-tools no longer lets a professor edit it: cancelled, complete, or past its edit window. */
  | 'tournament_locked'
  /** A date change before the current date − 3 days (`details.opensOn`). */
  | 'reschedule_window_not_open'
  /** A date change after the current date + 90 days (`details.closesOn`). */
  | 'reschedule_window_closed'
  /** A premier event's new date outside its series' window (`details.window`). */
  | 'outside_series_window'
  /** A premier event's new format isn't one of its series'. */
  | 'format_not_in_series'
  /** The new venue isn't in the organizer's address book. */
  | 'venue_not_found'
  /** A clock change skips or repeats the new start. */
  | 'start_time_invalid'
  /** No field differs from what the tournament has. */
  | 'nothing_to_change'
  /** A scope or siblings for a tournament that isn't from a schedule. */
  | 'not_in_schedule'
  /** **Update the template** for a tournament made in play-tools. */
  | 'no_template'
  /** Everything was excluded or left out. */
  | 'nothing_to_edit'
  // Cancel… (#94, ADR-0010 decision 8)
  /** A planned row that never reached play-tools: Skip it instead (`details.state`). */
  | 'not_in_play_tools'
  /** Anyone is registered, and the display id (or date) typed doesn't match exactly (`details.required`). */
  | 'confirmation_mismatch'
  /** A retry of a cancel job whose tournament is already cancelled. */
  | 'nothing_to_cancel';

export class TournamentsError extends Error {
  override name = 'TournamentsError';
  constructor(
    readonly code: TournamentsErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
