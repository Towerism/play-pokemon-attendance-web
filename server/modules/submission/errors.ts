export type SubmissionErrorCode =
  /** No upstream league is chosen in Settings. */
  | 'league_not_selected'
  /** The Pokémon account may not record attendance for the league. */
  | 'cannot_submit'
  /** The play session is not one of that date's sessions. */
  | 'unknown_play_session'
  /** The session's attendance edit window has closed (S3). */
  | 'edit_window_closed'
  /** Nobody to submit: no regulars and no session players. */
  | 'nothing_to_submit'
  /** A submission for the league is already running. */
  | 'submission_running'
  /** The app is stopping; start again after it restarts. */
  | 'shutting_down'
  /** No such submission. */
  | 'not_found';

export class SubmissionError extends Error {
  override name = 'SubmissionError';
  constructor(
    readonly code: SubmissionErrorCode,
    message: string,
  ) {
    super(message);
  }
}
