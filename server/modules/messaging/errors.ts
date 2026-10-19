export type MessagingErrorCode =
  /** Genie hasn't polled in the last 2 minutes, so nothing would deliver the message (ADR-0015 §7). */
  | 'genie_unavailable'
  /** No such message in the token's league. */
  | 'message_not_found'
  /** The app is stopping: polls are answered empty and new ones refused until it is back. */
  | 'shutting_down';

export class MessagingError extends Error {
  override name = 'MessagingError';
  constructor(
    readonly code: MessagingErrorCode,
    message: string,
  ) {
    super(message);
  }
}
