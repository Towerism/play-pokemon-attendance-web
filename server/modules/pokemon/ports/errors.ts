/**
 * Errors that may cross the pokemon port boundary. Adapters translate every
 * upstream failure into one of these, so callers never see a raw HTTP status
 * or payload.
 */

export type PokemonErrorCode =
  /** Refresh token rejected (`invalid_grant`); the organizer must reconnect. */
  | 'needs_reconnect'
  /** No connection configured for this league. */
  | 'not_connected'
  /** Access token accepted by Hydra but refused by the OP API (401/403). */
  | 'forbidden'
  /** Upstream throttled us (429); `retryAfterMs` set when the server said so. */
  | 'rate_limited'
  /** Upstream 5xx or network failure, retryable. */
  | 'unavailable'
  /** Response did not match the frozen wire contract. Raw body is logged. */
  | 'unexpected_shape'
  /** Requested resource does not exist upstream (404). */
  | 'not_found';

export class PokemonUpstreamError extends Error {
  override readonly name = 'PokemonUpstreamError';

  constructor(
    readonly code: PokemonErrorCode,
    message: string,
    readonly details: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
  }

  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'unavailable';
  }
}
