# M0 spike findings

Status: **In progress.** Tooling and contracts are done; the live runs need the organizer's PTC login.
How to run them: [`spikes/README.md`](../../spikes/README.md).

| ID | Question | Status | Answer | Decision |
| -- | -------- | ------ | ------ | -------- |
| S1 | Does a PKCE code for our verifier survive landing on `play-tools/loggedIn` long enough to paste? | 🟡 half verified | Hydra accepts our authorize request (F2). Redemption is not yet tested. Login can't be automated (F5). | — |
| S2 | Refresh-token lifetime and rotation | ⚪ not run | | |
| S3 | `play_sessions` shape: date field, timezone, pagination, statuses | ⚪ not run | | |
| S4 | `_bulk` semantics: response, partial failure, already-present player | ⚪ not run | | |
| S5 | Which id does `users/{id}/activity_groups/` take? | ⚪ not run | | |

## Verified without a login (2026-10-10)

**F1. The OIDC discovery document matches the bundle analysis.** Source: `GET https://access.pokemon.com/.well-known/openid-configuration`.

- The issuer is `https://access.pokemon.com/`, and the endpoints are `/oauth2/auth`, `/oauth2/token`, `/oauth2/revoke` and `/oauth2/sessions/logout`. These match ADR-0003.
- The document advertises `code_challenge_methods_supported: [plain, S256]` and the `refresh_token` grant.
- `token_endpoint_auth_methods_supported` includes `none`, so a public client can refresh with no secret.
- `scopes_supported` lists only `offline_access`, `offline` and `openid`. `organized_play` is a custom scope that isn't advertised but is accepted (F2).
- `userinfo_endpoint` is `https://me.pokemon.com/me`. S5 tries it as a source of user ids.
- `revocation_endpoint` exists, so "Disconnect revokes the token" (§9) is implementable.

**F2. Our own PKCE authorize request is accepted.** A `GET /oauth2/auth` with these parameters returned
`302 → https://access.pokemon.com/login?login_challenge=…`:
- `client_id=op-tools-app`
- `scope=openid organized_play offline`
- `audience=https://op-core.pokemon.com`
- `redirect_uri=https://play-tools.pokemon.com/loggedIn`
- our own S256 `code_challenge`

Client, redirect URI, scope, audience and PKCE all pass Hydra validation, so the
first half of S1 holds. Still open: whether the code survives the play-tools page, and whether the exchange succeeds.

**F3. The device-code grant is not available. This rules out a redirect-free alternative.** The discovery document advertises
`/oauth2/device/auth`, which would have avoided the fixed-redirect problem
altogether. A `POST /oauth2/device/auth` with `client_id=op-tools-app` returned
`400 invalid_grant: "The requested OAuth 2.0 Client does not have the
'urn:ietf:params:oauth:grant-type:device_code' grant."` So the capture options
in §4.2 remain the only routes.

**F4. Facts from the predecessor CLI source** (`Towerism/play-pokemon-attendance`):
- The activity group it hardcodes is `df02d0b2-a68e-974f-ab86-878ca8f574e9`. S3 falls back to it.
- The record-id field was guessed as `id || record_id || guid || id_record`, and list items as `results || data`. The wire schema accepts every candidate until S3/S4 pin them.
- `delete.js` always re-reads `page=1` while deleting, because deletions shift the pages. The adapter's undo must do the same, or collect all record ids first and then delete.
- The CLI sent a full spoofed Chrome header set (`sec-ch-ua`, …). The adapter sends a minimal, honest set instead (`accept`, `origin`/`referer` = play-tools). S3 shows whether that is accepted.

**F5. The interactive login page is behind Imperva Incapsula bot protection.** Headless Chromium (Playwright 1.55) loading
`/login?login_challenge=…` got an Incapsula "Request unsuccessful" incident page with no
login form, and a plain `fetch` of `/login` returns the Incapsula page too. No attempt was made to get around it.
This is hard evidence for ADR-0003's rejection of storing the password and logging in headlessly: such a login
would not just be fragile, it is actively blocked. **S1 must be done in a real browser by a person.**

**F6. The token endpoint and the OP API are *not* behind that challenge for plain server-side clients.** These went through from Node `fetch` with no browser headers:
- `POST /oauth2/token` (a bogus refresh) → a normal `400 invalid_grant` JSON response.
- `GET api.play.pokemon.com/services/core/…/play_sessions/` with no token → `401 application/json`:
  `{"code":"op.generic.unauthorized","message":"Request is not authenticated for the request.","errors":{"header":{"Authorization":[{"code":"op.value.required",…}]}}}`

So server-side refresh, the keep-alive task and adapter calls are feasible from the container. The error envelope
is now `OpErrorResponse` in `wire.ts`. (Whether *authenticated* calls with minimal headers pass is still for S3 to show.)

## Decision rules (apply when the results are in)

- **S1**
  - Loaded mode works → paste-back (§4.2 a) is the v1 connect UX.
  - Only blocked mode works → ship paste-back with the DevTools-block instructions as a stopgap, and promote the MV3 companion extension (§4.2 b) to M4 scope.
  - Neither works → the extension is mandatory, and manual token paste is the fallback.
- **S2**
  - Chain survives a ≥ 7-day idle gap → keep the daily keep-alive as belt and braces.
  - Chain dies in under 7 days idle → keep-alive is load-bearing: add alerting when it fails, and surface "last refreshed" prominently.
  - Reuse revokes the chain → the per-connection mutex plus persist-before-use rule (ADR-0003) is mandatory, so keep it.
- **S3**
  - Pin the start field and its timezone semantics, the pagination style, and the status values in `wire.ts`.
  - If server-side date filters exist, use them in §4.4 instead of paging by status.
- **S4**
  - Duplicate add is a no-op or an error → reconcile-by-read (ADR-0004) is enough.
  - Duplicate add creates a second record → the plan step is load-bearing for correctness, and the undo must dedupe.
  - Pin the `BulkResponse` schema and how per-item errors map to `BulkResult.failed`.
- **S5**
  - Record the claim/source that yields the OP user id, and drop the other candidates from `AccessTokenClaims`.

## Results

<!-- Paste the non-secret summaries from spikes/.secrets/s1-result.*.json and the S2 report here. Never paste tokens, names or player ids. -->

### S1

### S2

### S3

### S4

### S5
