# M0 spike findings

Status: **In progress.** S1, S3 and S5 are done (2026-10-10). S2 is collecting data until about 2026-10-19. S4 is waiting on a throwaway session.
How to run them: [`spikes/README.md`](../../spikes/README.md).

| ID | Question | Status | Answer | Decision |
| -- | -------- | ------ | ------ | -------- |
| S1 | Does a PKCE code for our verifier survive landing on `play-tools/loggedIn` long enough to paste? | ✅ done | **Yes, even in "loaded" mode.** The play-tools page loaded and the code still redeemed 99 s after the attempt started. Login can't be automated (F5). | Paste-back (§4.2 a) is the v1 connect UX. The extension is not needed. |
| S2 | Refresh-token lifetime and rotation | 🟡 running | The refresh token **rotates on every refresh** (`ory_rt_…`). The access token is a 1 h JWT. Idle-TTL and reuse probes are still pending. | Persist-before-use stays mandatory. |
| S3 | `play_sessions` shape: date field, timezone, pagination, statuses | ✅ done | UTC `start_date`/`end_date`. Statuses are `active`/`pending`/`complete`. DRF pagination. Server-side date filters exist. No title field. Attendance locks at `final_modifiable_datetime` (= start + 7 d). | §4.4 and the submission flow change ([below](#design-changes-triggered-apply-in-m4m5)). |
| S4 | `_bulk` semantics: response, partial failure, already-present player | ⏳ waiting | Needs a throwaway session and a player id from the organizer. | — |
| S5 | Which id does `users/{id}/activity_groups/` take? | ✅ done | The access-token `sub` claim (32 hex chars). | `TokenProvider` exposes `subject`. League discovery = filter `group_type === "league"`. |

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

<!-- Non-secret summaries only. Never paste tokens, names or player ids. -->

### S1: paste-back works (2026-10-10)

- **Mode tried:** "loaded". The organizer logged in normally, let `play-tools.pokemon.com/loggedIn` render, and then copied the URL.
- **Result:** the code was redeemed with our verifier, 99 s after the attempt was created. The play-tools SPA does **not** consume a code whose `state` it didn't create.
- **Token response:** `access_token`, `token_type: "bearer"`, `expires_in: 3599`, `scope: "openid organized_play offline"`, `refresh_token` (opaque `ory_rt_…`) and `id_token`.
- **Access token:** an RS256 JWT with claims `aud` (array, `https://op-core.pokemon.com`), `client_id` (`op-tools-app`), `exp`, `ext` (empty object), `iat`, `iss` (`https://access.pokemon.com/`), `jti`, `nbf`, `scp` and `sub`.
- **id_token claims:** `at_hash`, `aud`, `auth_time`, `exp`, `iat`, `iss`, `jti`, `rat`, `sid` and `sub`.
- **Blocked mode:** not needed.

### S2: rotation confirmed; lifetime still being measured

| When (UTC) | Result |
| --- | --- |
| 2026-10-10 23:10 | refresh OK, **rotated** (fp `4a69d625e3d2` → `9b733d24e433`), new access token valid for 1 h |

To do: a refresh on 2026-10-11 and 2026-10-12, then nothing until ≥ 2026-10-19 (the 7-day idle gap). Then run `pnpm spike:s2 report` and `probe-reuse`.

### S3: play sessions and attendance (2026-10-10, league L5012)

- **Statuses** are `active`, `pending` and `complete`.
  - `scheduled` and `completed` are rejected: `400 op.value.invalid_choice`.
  - Counts at capture time: 0 active, 27 pending, 109 complete.
  - Source: the play-tools league-details lazy chunk.
- **Pagination** is DRF (`count`, `next`, `previous`, `results`), sorted by `start_date` ascending. `page_size` is honoured.
- **Session item:** `guid`, `type` (`open_play`), `status`, `start_date`, `end_date`, `final_modifiable_datetime`, `products` (`tcg` | `vg` | `pgo`), `attributes` (`[{id}]` tags) and `schedule`. There is **no name or title**.
- **Times are UTC ISO instants.** This league runs Sunday 17:00Z and Tuesday 23:00Z, i.e. noon and 6 PM Central. After DST ends, the Tuesday session starts at **00:00Z on Wednesday**, so UTC dates are wrong and the league timezone is required.
- **Server-side date filters work.** `start_date:greater_than_or_equal_to=<ISO>` and `start_date:less_than_or_equal_to=<ISO>`, combined with `status`, returned exactly the 8 sessions in a 30-day window.
- **`final_modifiable_datetime` = `start_date` + 7 days** on every session observed. This is presumably when attendance edits close.
- **Attendance record:** `guid` (the record id), `role` (null), `player` (true), `origin` (`roster`), `updated` (ISO) and `participant`. The participant has `guid`, a 7-digit string `player_id`, `display_first_name`, `display_last_name` and `user.guid`. The 2026-10-06 session had 37 records.
- **Headers:** the minimal, honest header set (`accept`, `origin`, `referer`, `authorization`) is accepted. No browser fingerprint headers are needed.
- **Other endpoints** in the bundle that we don't use yet:
  - `POST …/records/` (add a single record);
  - `PATCH …/records/{id}/`;
  - `GET …/play_sessions/{id}` (details);
  - `GET …/play_sessions/attributes`.

### S4

Not run yet.

### S5: identity (2026-10-10)

- `GET core/users/{access_token.sub}/activity_groups/` → 200. The id is `sub`; no other lookup is needed.
- It returns two groups: `group_type: "personal"` and `group_type: "league"` (`display_id` `L5012`, the same guid the CLI hardcoded).
- Group fields:
  - `guid`, `display_id`, `group_type`, `name` (null), `display_name` (the store name), `organization_id`, `owner {guid, player_id}`, `address`, `store_owner_terms_accepted` and `level`;
  - `criteria`: the caller's **permissions** per resource, e.g. `play_sessions.create_attendance`.
- `https://me.pokemon.com/me` → 200 with `guid`, `consent_age`, `mailing_address`, `meta` and `organized_play`. Not needed.

## Design changes triggered (apply in M4/M5)

1. **§4.4 date → session:** make one query with `start_date:greater_than_or_equal_to = localMidnight(date)` and `start_date:less_than_or_equal_to = localMidnight(date + 1)`, both converted to UTC, per status. Don't page through all sessions. `PlaySessionStatus` is now `active | pending | complete`.
2. **Edit window:** show the session's `final_modifiable_datetime` in the submit dialog, and refuse or warn when it has passed. Attendance has to be submitted within a week. S4 should confirm what upstream returns after the deadline.
3. **Session label:** build it from `type`, `products` and the local start time (e.g. "Open play · TCG · Tue 6:00 PM"), because there's no title.
4. **League discovery:** list the user's groups, keep `group_type === "league"`, and show `display_name (display_id)`. Check `criteria.play_sessions.create_attendance` before allowing a submit.
5. **Upstream sightings:** records carry participant names, so `PLAYER` rows created from `upstream_existing` sightings can get a `display_name` right away.
