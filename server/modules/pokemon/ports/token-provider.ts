/**
 * TokenProvider port (ADR-0003, ADR-0008). Hands out a bearer access token for
 * the OP API on behalf of one professor's Pokémon connection.
 *
 * Contract:
 * - Returns a cached token while it has ≥ 2 minutes of validity left.
 * - Otherwise refreshes under a per-connection mutex and persists the rotated
 *   refresh token *before* returning the new access token.
 * - On `invalid_grant` marks the connection `needs_reconnect` and throws
 *   `PokemonUpstreamError('needs_reconnect')`.
 * - Never logs or returns the refresh token.
 */
export interface TokenProvider {
  getAccessToken(connectionId: number): Promise<AccessToken>;
}

export interface AccessToken {
  /** Raw bearer value, without the `Bearer ` prefix. */
  readonly value: string;
  readonly expiresAt: Date;
  /** PTC subject (`sub` claim); also the OP user id for `core/users/{id}/activity_groups/` (S5). */
  readonly subject: string;
}

/** Status surfaced to the UI (`GET /api/pokemon/connection`). */
export type ConnectionStatus = 'connected' | 'needs_reconnect' | 'not_connected';
