/**
 * access.pokemon.com (Ory Hydra) client parameters used by play-tools.
 *
 * Verified 2026-10-10 against /.well-known/openid-configuration and an
 * unauthenticated /oauth2/auth probe (302 → /login?login_challenge=…).
 * See docs/architecture/spikes.md.
 */
export const PTC_OAUTH = {
  issuer: 'https://access.pokemon.com/',
  authorizeEndpoint: 'https://access.pokemon.com/oauth2/auth',
  tokenEndpoint: 'https://access.pokemon.com/oauth2/token',
  revokeEndpoint: 'https://access.pokemon.com/oauth2/revoke',
  userinfoEndpoint: 'https://me.pokemon.com/me',
  clientId: 'op-tools-app',
  scope: 'openid organized_play offline',
  audience: 'https://op-core.pokemon.com',
  redirectUri: 'https://play-tools.pokemon.com/loggedIn',
} as const;
