# ADR-0003: Pokémon auth via one-time PKCE connect + stored refresh token

- Status: Proposed (pending spikes S1, S2, S5)
- Date: 2026-10-10

## Context

Every play-tools API call needs a bearer JWT issued by `access.pokemon.com`.
The CLI required copying it from devtools each run. The requirement is that
the system "automatically gets a JWT".

Facts recovered from the production play-tools bundle:

- access.pokemon.com is Ory Hydra (`/oauth2/auth`, `/oauth2/token`, `/oauth2/sessions/logout`).
- play-tools is a public client:
  - `client_id=op-tools-app`
  - authorization code + PKCE S256
  - `scope=openid organized_play offline`
  - `audience=https://op-core.pokemon.com`
  - `redirect_uri=https://play-tools.pokemon.com/loggedIn` (fixed)
- It refreshes with `grant_type=refresh_token` + `client_id` and no secret, as a form-encoded POST to `/oauth2/token`.

## Options considered

1. **Manual token paste (status quo).** Not automatic, and needed on every run.
2. **Store PTC username + password and log in with a headless browser.** Fully automatic, but:
   - it stores the organizer's most sensitive credential;
   - it breaks on CAPTCHA, MFA or login-page changes;
   - it needs a Chromium in the container (+400 MB);
   - it is the most clearly "automated access" under the play-tools Terms.
3. **One-time interactive PKCE connect, then refresh-token rotation on the server.** The organizer logs in on Pokémon's own page. The server keeps only a refresh token and mints access tokens on demand.
4. **Our own OAuth client registration with TPCi.** This is the correct long-term answer, but it is not available today.
5. **Device authorization grant** (`/oauth2/device/auth`, advertised by Hydra). It would avoid the fixed redirect URI entirely, but it was rejected for `op-tools-app` on 2026-10-10 (the client lacks the device_code grant; see [spikes.md](../spikes.md) F3).

## Decision

Option 3, with option 1 kept as an "Advanced" fallback. Ask TPCi about option
4 in parallel.

The code-capture mechanism, because the redirect URI is fixed to
play-tools, is decided by spike S1:

- (a) The user pastes the post-login URL back into the app, or
- (b) a minimal MV3 companion browser extension captures `play-tools.pokemon.com/loggedIn?code=…` and posts it to the app.

Token handling rules:

- The refresh token is encrypted with AES-256-GCM using `TOKEN_VAULT_KEY` from the environment, and is never returned to the client or logged.
- Refresh is serialized per connection. **The rotated refresh token is persisted before the access token is used**, because reuse of a rotated token revokes the chain in Hydra.
- The access token is cached in memory until 2 minutes before `exp`.
- A daily keep-alive refresh runs. On `invalid_grant`, the connection is set to `needs_reconnect` and the UI shows a banner.

## Consequences

- (+) The weekly flow needs no token handling at all, and the password is never seen by our system.
- (+) The token vault is small and testable, and the behaviour sits behind the `TokenProvider` port.
- (−) It depends on undocumented client behaviour, so if TPCi changes the client or adds checks it breaks. The blast radius is limited to the `pokemon` module, and the manual fallback stays available.
- (−) A stolen refresh token lets someone act as the organizer. That is mitigated by encryption at rest, key separation, and revoke-on-disconnect.
