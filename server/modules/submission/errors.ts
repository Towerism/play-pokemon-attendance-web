export type SubmissionErrorCode =
  /** No upstream league is chosen in Settings. */
  | 'league_not_selected'
  /** The Pokémon account may not record attendance for the league (or none of the caller's may). */
  | 'cannot_submit'
  /** The caller has several connections that can submit and named none (ADR-0015 §4). */
  | 'submit_as_required'
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
  | 'not_found'
  /** The submission is an undo itself, or is still running. */
  | 'not_undoable'
  /** The submission added nobody that an undo has not removed already. */
  | 'nothing_to_undo'
  /** Clear session: the typed date does not match the session's date. */
  | 'confirmation_mismatch'
  /** Clear session: the play session has no player records. */
  | 'nothing_to_clear'
  /** Only the owner may do this, retrying an import included (ADR-0015 §4). */
  | 'owner_only';

export class SubmissionError extends Error {
  override name = 'SubmissionError';
  constructor(
    readonly code: SubmissionErrorCode,
    message: string,
  ) {
    super(message);
  }
}
