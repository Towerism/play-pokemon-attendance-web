# M0 spike findings

Status: **Contracts frozen.** S1, S3, S4 and S5 are done (2026-10-10). S2 runs as an hourly cron in Docker (see `spikes/README.md`).
How to run them: [`spikes/README.md`](../../spikes/README.md).

| ID | Question | Status | Answer | Decision |
| -- | -------- | ------ | ------ | -------- |
| S1 | Does a PKCE code for our verifier survive landing on `play-tools/loggedIn` long enough to paste? | ✅ done | **Yes, even in "loaded" mode.** The play-tools page loaded and the code still redeemed 99 s after the attempt started. Login can't be automated (F5). | Paste-back (§4.2 a) is the v1 connect UX. The extension is not needed. |
| S2 | Refresh-token lifetime and rotation | 🟡 running | The refresh token **rotates on every refresh** (`ory_rt_…`). The access token is a 1 h JWT. Idle-TTL and reuse probes are still pending. | Persist-before-use stays mandatory. |
| S3 | `play_sessions` shape: date field, timezone, pagination, statuses | ✅ done | UTC `start_date`/`end_date`. Statuses are `active`/`pending`/`complete`. DRF pagination. Server-side date filters exist. No title field. Attendance locks at `final_modifiable_datetime` (= start + 7 d). | §4.4 and the submission flow change ([below](#design-changes-triggered-apply-in-m4m5)). |
| S4 | `_bulk` semantics: response, partial failure, already-present player | ✅ done | 201 `[{guid}]` in request order. **All-or-nothing:** one rejected item adds nobody. Duplicate → 400 `cannot_duplicate_participant` (index-keyed). Non-numeric id → HTML 500. The session creator holds a hidden organizer record. DELETE → 204. | Diff against **all** records. Validate ids locally. Retry without the offending index. (See design changes 6–9.) |
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

Plan (changed 2026-10-10 at the organizer's request): refresh **hourly** from the `spikes` Docker container (`spikes/crontab`) for at least a week, then run `docker compose exec spikes pnpm spike:s2 report`. This proves the chain survives continuous rotation, which mirrors the app's keep-alive. It does not measure the idle TTL; a long idle gap remains an optional, separate experiment.

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

### S4: first run (2026-10-10, throwaway session, organizer's own player id)

- **The throwaway session** was created by the organizer in play-tools: `active`, 1 h long, products `pgo`/`tcg`/`vg`. The details endpoint `GET …/play_sessions/{id}/` also returns a `description` field.
- **Every session has a hidden organizer record.** Creating a session gives its creator a record with `player: false`, `role: "organizer"` and `origin: "unknown"`. `?player=true` hides it. The unfiltered list and `?player=false` show it.
- **Adding a participant who already holds a record (any role)** returns `400`:
  `{"code":"op.generic.bad_request","message":"Invalid request.","errors":{"body":{"0.participant.player_id":[{"code":"op.activity_record.cannot_duplicate_participant",…}]}}}`.
  This happened on both attempts, and no second record was created.
- **A batch of `[organizer, "not-a-player-id"]` returned `500`** with an HTML "Server Error (500)" page. The record count didn't change.
- **Cleanup:** the session was restored to its snapshot. Nothing was added, so nothing had to be deleted.
**Second and third runs (2026-10-10, organizer + two consenting players):**

- **The batch `[organizer, A, B]` → 400** with a duplicate error at index 0 only, and **neither A nor B was added**. So `_bulk` is atomic: one rejected item blocks the whole batch.
- **Single add `[A]` → `201 [{"guid": "<recordId>"}]`**. The same for `[B]`.
- **Adding A again → 400 `cannot_duplicate_participant`.** No second record was created.
- **The batch `[A, B]` → `201`** with two guids **in request order** (checked against the listing).
- **`DELETE …/records/{guid}/` → `204`.** The session was restored to its snapshot (just the organizer record) after every run.

### S5: identity (2026-10-10)

- `GET core/users/{access_token.sub}/activity_groups/` → 200. The id is `sub`; no other lookup is needed.
- It returns two groups: `group_type: "personal"` and `group_type: "league"` (`display_id` `L5012`, the same guid the CLI hardcoded).
- Group fields:
  - `guid`, `display_id`, `group_type`, `name` (null), `display_name` (the store name), `organization_id`, `owner {guid, player_id}`, `address`, `store_owner_terms_accepted` and `level`;
  - `criteria`: the caller's **permissions** per resource, e.g. `play_sessions.create_attendance`.
- `https://me.pokemon.com/me` → 200 with `guid`, `consent_age`, `mailing_address`, `meta` and `organized_play`. Not needed.

### S6: staff assignment (planned)

This decides the staff methods on `PlayToolsGateway` ([ADR-0007](adr/0007-staff-assignment.md), issue #41). Nothing
about staff is built until its fixtures exist.

- **Capture:** the organizer works in their own logged-in browser; there is no headless login. On
  play-tools, they open DevTools → Network (filter `api.play.pokemon.com`), then:
  - open a tournament's page and its staff section;
  - assign one consenting staffer;
  - remove the staffer again.

  Then they save the HAR outside the repo. Tokens, cookies and every name other than the consenting test
  people are scrubbed before anything becomes a fixture under `server/modules/pokemon/adapters/play-tools/fixtures/`.
- **Questions:**
  1. The endpoints, methods and request/response bodies for listing, assigning and removing staff. Is it
     `POST …/records/` with `player: false` and a `role`?
  2. Is the tournament the date's play session, or a separate resource? How does the page find it from a date?
  3. Where the role list comes from (an endpoint or a bundle constant), and its codes and labels.
  4. How the event lists everyone on it, so the app can check "is this player id already listed" (players and
     staff, every page) before every assign. The app never sends such an assignment, so the capture doesn't need
     to provoke a duplicate.
  5. How the tournament names its organizer (S4: a record with `role: "organizer"`), so the app can refuse to
     staff them. The organizer role is fixed and never assigned.
  6. Behaviour after `final_modifiable_datetime`, and which `criteria` permission gates staff edits.
- **Result:** fill in the gateway contract in architecture §4.3, settle ADR-0007's open questions, and add the
  routes to `test/server/fake-pokemon.ts`.

## Design changes triggered (apply in M4/M5)

1. **§4.4 date → session:** make one query with `start_date:greater_than_or_equal_to = localMidnight(date)` and `start_date:less_than_or_equal_to = localMidnight(date + 1)`, both converted to UTC, per status. Don't page through all sessions. `PlaySessionStatus` is now `active | pending | complete`.
2. **Edit window:** show the session's `final_modifiable_datetime` in the submit dialog, and refuse or warn when it has passed. Attendance has to be submitted within a week. S4 should confirm what upstream returns after the deadline.
3. **Session label:** build it from `type`, `products` and the local start time (e.g. "Open play · TCG · Tue 6:00 PM"), because there's no title.
4. **League discovery:** list the user's groups, keep `group_type === "league"`, and show `display_name (display_id)`. Check `criteria.play_sessions.create_attendance` before allowing a submit.
5. **Upstream sightings:** records carry participant names, so `PLAYER` rows created from `upstream_existing` sightings can get a `display_name` right away.
6. **Plan step (ADR-0004):** `existing` must come from the **unfiltered** records list (all roles), not `?player=true`. Otherwise the organizer, or any staff member who is also on the regulars list, is "missing" on every run, gets re-sent, and fails.
   - Report such players as `already_present`, with a note that they are present in a staff role.
   - Don't count staff-role records as a `SIGHTING`.
7. **Pre-flight validation:** a single malformed id makes the whole bulk call fail with an HTML 500. Validate every id with `toPlayerId` (digits only) before sending, and never send a batch containing an id that fails it.
8. **Bulk error mapping:** parse 400 bodies as `OpErrorResponse`. Map `errors.body["<i>.participant.player_id"]` back to `playerIds[i]`, treating `cannot_duplicate_participant` as `alreadyPresent` and anything else as `failed`. Treat a non-JSON 5xx as a batch-level failure, then reconcile by re-reading.
9. **Atomic batches (ADR-0004 execute step):** a rejected batch added *nobody*. After a 400, take the flagged indices out of the batch and resend the remainder once (respecting the ≥ 15 s spacing). The 201 body maps request index → record guid, so `SUBMISSION_ITEM` can store the upstream record id for undo without a re-read. Reconciliation still re-reads.
10. **Late-landing batches (field report, M5):** submitting a large batch can answer **502 (gateway
    timeout)**, yet about a minute later the records list holds every player from the request. A 5xx from
    `_bulk` therefore means "outcome unknown", not "nothing added": re-read for a settle window before
    resending (built in M5; see architecture §6.2).
