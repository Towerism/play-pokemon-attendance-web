/**
 * Port to access.pokemon.com (Ory Hydra), used only by the connection service
 * that implements `TokenProvider`. Hydra's JSON never crosses it.
 *
 * Every method may throw `PokemonUpstreamError`; an `invalid_grant` (a used,
 * expired or revoked code or refresh token) is `needs_reconnect`.
 */
export interface PtcOAuthClient {
  /** Where the organizer logs in on Pokémon's own page (PKCE S256). */
  authorizeUrl(challenge: string, state: string): string;
  exchangeCode(code: string, verifier: string): Promise<TokenGrant>;
  refresh(refreshToken: string): Promise<TokenGrant>;
  revoke(refreshToken: string): Promise<void>;
}

export interface TokenGrant {
  readonly accessToken: string;
  readonly expiresAt: Date;
  /** `sub` claim of the access token: the OP user id (S5). */
  readonly subject: string;
  /** The rotated refresh token; `null` when Hydra did not send one. */
  readonly refreshToken: string | null;
}
