export type IntegrationErrorCode =
  /** A league already holds the most integration tokens it may. */
  | 'token_limit'
  /** No such token in this league. */
  | 'not_found'
  /**
   * A connected professor has no player id yet, so a consumer couldn't tell which tournaments are theirs:
   * the day is refused rather than answered without them (#115).
   */
  | 'professor_unidentified';

export class IntegrationError extends Error {
  override name = 'IntegrationError';
  constructor(
    readonly code: IntegrationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
