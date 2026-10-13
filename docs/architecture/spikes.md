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
| S6 | Staff (M8): tournament list, staff assign/remove calls, roles, organizer, edit window | ✅ done | One `POST core/tournaments/{guid}/records` per staffer → 201 `{guid}`; duplicate/unclaimed/uncertified → 400 keyed `participant.player_id`; past the window → 423 `cannot_modify_old_activity` (assume locked to all changes); `PATCH`/`DELETE …/records/{guid}` → 204. Unfiltered records = players + staff. Organizer in `core/tournament/{guid}`. `core/activities` lists the organizer's tournaments but **ignores date filters**. Staff tab is organizer-only (403 otherwise). | See [S6](#s6-staff-assignment-done-2026-10-11); §4.3 and ADR-0007 to be updated by #41's owner. |
| S8 | Tournament create, cancel, reschedule and TDF upload (M9) | 🟡 part 1 done | `POST core/tournament`; cancel = `PATCH core/tournament/{guid}/ {application_state: cancelled}` (delete is admin-only); TDF upload = `POST triumph/tdf/` (validate, base64) then `PUT triumph/{upload_guid}/confirm/`. No templates or recurrence upstream. Date wire format behind a remote flag. | See [S8](#s8-tournament-lifecycle-and-tdf-upload-part-1-done-2026-10-12); ADR-0010, ADR-0011. Live capture (part 2) before any write is built. |

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

### S7: the professor's name (2026-10-12, #66)

- `pnpm spike:s7` printed paths and types only (name-like values masked).
- `id_token` claims: `at_hash, aud, auth_time, exp, iat, iss, jti, rat, sid, sub`. No name.
- `me.pokemon.com/me`: `consent_age`, `guid`, `mailing_address.country_region_code`, `meta.*` (token metadata) and
  `organized_play.{player_id (number), player_rankings_opt_in, terms}`. No name.
- The personal activity group's `owner.player_id` is present (7 digits), as S5 found.
- **Outcome (ADR-0008):** no upstream name source. Professors are shown as "Professor <player ID>" unless the organizer
  gives them a display name in Settings.

### S6: staff assignment (done 2026-10-11)

This decides the staff methods on `PlayToolsGateway` ([ADR-0007](adr/0007-staff-assignment.md), issue #41). Nothing
about staff is built until its fixtures exist.

S6 runs in two parts:

1. **Bundle analysis.** Done 2026-10-11, no login (findings below).
2. **Live capture.** Done 2026-10-11 with `pnpm spike:s6-live` instead of a HAR ([part 2](#part-2-live-capture-2026-10-11)).
   It confirms the bundle's claims with fixtures, and corrects one of them: date filters on `core/activities`.

#### Part 1: what the public play-tools bundle shows (2026-10-11)

The play-tools SPA bundle (`https://play-tools.pokemon.com/assets/index-*.js` and its chunks) is
Istanbul-instrumented, so every module carries its source path (e.g.
`src/components/TournamentsView/TournamentDetail/Tabs/StaffTab/StaffHeading`). Nothing was called. The answers
below are what the client *sends* and *expects*. Claims marked *(inferred)* need the HAR.

**Transport.**

- The base URL is `https://api.play.pokemon.com/services`, the same gateway as play sessions.
- Requests carry only `Authorization: Bearer …`, `Content-Type` and `Accept: application/json`.
- Paths are built without a trailing slash (`core/tournaments/{guid}/records`).
- The client has no rate-limit or throttle logic of its own.

**Q1. Assign, change and remove** (`TournamentService`, Staff tab). `{t}` is the tournament `guid` (not its
`display_id`), and `{r}` is the staff record's `guid`.

| Action | Call | Body |
| ------ | ---- | ---- |
| Assign | `POST core/tournaments/{t}/records` | **One object**, not a list: `{"role":"judge","player":false,"participant":{"player_id":"…"},"origin":"manual"}` |
| Assign, role needs a certification the person lacks | same | **400**, same envelope, code `op.activity_record.missing_certification` ("The given user lacks the appropriate certificate for the given role.") |
| Assign, tournament past its edit window | same | **423** `{"code":"op.activity.cannot_modify_old_activity","message":"The given activity is no longer modifiable."}`. There is **no `errors.body`**: the whole tournament is locked, not one staffer. |
| Change role | `PATCH core/tournaments/{t}/records/{r}` | JSON-Patch array: `[{"op":"replace","path":"/role","value":"scorekeeper"}]` |
| Remove | `DELETE core/tournaments/{t}/records/{r}` | `[{"legacy_alias":"<the staffer's player_id>"}]` |

- **Assign has no lookup step.** The UI is a plain *Player ID* field and a role select, and it posts straight away.
- **A tournament has no invite or consent step.** Invites exist only for *league* staff, a different feature.
- **Assign errors:**
  - 403 → "User is not authorized to add staff to this tournament".
  - Otherwise `errors.body["participant.player_id"]` holds a list of `{code, attributes}`.
- **Codes the UI translates** (*which ones the assign endpoint really returns is inferred*):

  | Code | Meaning |
  | ---- | ------- |
  | `op.activity_record.cannot_duplicate_participant` | Already listed |
  | `op.activity_record.missing_certification` | No certification for this role |
  | `op.activity_record.player_id_must_be_claimed` | Player id not claimed |
  | `op.player.no_user` | No user |
  | `op.player.below_age` | Below age |
  | `op.player.disciplined` | Disciplined |
  | `op.player.merged_player_id` | Merged id; attributes carry `provided_player_id` → `actual_player_id` |
  | `op.value.unknown_reference` | Invalid player id |

  With no code, the UI falls back to "Player ID … is not a Professor". The UI also has strings for "was a
  participant and cannot also be on staff" and "has already been added to this event".
- **Change-role errors** come back per item as `errors.role[]`. Code `cannot.change.player.info` means the person
  is a participant.
- The assign response body is not used by the UI. *Its shape is inferred* (probably the created record).

**Q2. Listing tournaments.**

- "My tournaments" calls `GET core/activities` with `type=tournament`, `role=organizer`, `activity_group_id`,
  `product`, `sort_by`, `page_size=40` (or `days=90` / `year`). It follows the DRF `next` URL.
- `type` tells the two kinds apart: `tournament` vs `play_session`. Play sessions are activities too, so this is
  the same resource family seen through another endpoint.
- **Row fields:** `guid`, `name`, `display_id` (the tournament id people see), `start_date` / `start_date_v2` +
  `start_date_timezone`, `status`, `activity_state` and `activity_group`.
- **Status values:**
  - `status`: `sanctioned`, `complete`, `cancelled`, `deleted`, `approval-pending`, `sanctioning-error`, `invalidated`.
  - `activity_state`: `pending`, `upload_in_progress`, `upload_failed`, `completed`.
- **Date filters** use the S3 syntax: `start_date_v2:greater_than_or_equal_to` / `…:less_than_or_equal_to`.
  The bundle shows them on `core/users/{guid}/activities` (staffing history). *Whether `core/activities`
  accepts them is inferred.* **Part 2: it ignores them.**
- Details come from `GET core/tournament/{guid}`, singular.

**Q3. Roles are a bundle constant, not an endpoint.**

| Wire value | Label |
| ---------- | ----- |
| `judge` | Judge (the default) |
| `headjudge` | Head Judge |
| `scorekeeper` | Scorekeeper |
| `administration` | Support Staff |
| `translator` | Translator |

- `organizer` is fixed. It renders as a disabled select with no delete.
- `generic-staff` appears only as a play-session filter value.
- The client has no per-role checks. The server enforces certification.

**Q4. Everyone on the event** is `GET core/tournaments/{t}/records`, DRF-paged (`count`, `next`, `results`):

- **Staff:** `player=false`, `role:null=false`, `page_size=500`. The Staff tab reads one page only.
- **Players:** `player=true`, `status=active`, `page`, `page_size`. `useGetAllRecords` follows `next` to the end.
- **Fields:** `guid`, `role`, `participant.player_id` and `participant.display_first_name` / `display_last_name`.

The "already listed" check needs both lists, every page. One unfiltered pass would do if the server allows it
(*HAR*).

**Q5. The organizer.**

- Tournament details carry `organizer: {player_id, first_name, last_name}`.
- The records list also holds a `role: "organizer"` record, as in S4.
- The UI decides "is organizer" by comparing the user's player id with `organizer.player_id`.

**Q6. Edit window and permissions.**

- The UI enables *adding* staff until **90 days after the tournament's start** (`start_date_actual + 90 d`).
  After that, adding needs the admin permission `activities.modify_participant_staff`.
- The add section shows for the organizer, or for that admin permission. The tab shows with
  `view_participants` or `modify_participant_staff`.
- Change-role and remove are not gated by date or status in the UI. *What the server does after the window is
  unknown.*
- The play-session `final_modifiable_datetime` (start + 7 d) does not apply to tournaments.

**What this changes in ADR-0007** (for the ADR's owner to apply after the HAR):

- The assign body is a single object, so assign is **one call per staffer**. There is no `_bulk`. Batch spacing
  becomes per-call spacing.
- Remove needs the record `guid` *and* the player id (`legacy_alias`). The app should store the record `guid` from
  the assign response, or re-read the records list.
- Eligibility is server-side: certification, claimed id, age and discipline. Map its codes to per-staffer outcomes.
  `op.player.merged_player_id` is a "use this id instead" outcome, not a plain failure.
- The organizer check can use `organizer.player_id` from `GET core/tournament/{guid}`. No records scan is needed.
- The edit window is start + 90 d, not `final_modifiable_datetime`.

#### Part 2: live capture (2026-10-11)

This ran with `pnpm spike:s6-live` against the organizer's league (L5012), on a tournament held the same day, with
the organizer's go-ahead. The probe:

- removed the judge (one of two non-organizer staff);
- re-added them as judge in the very next write;
- probed a duplicate add, a role change and change back, and an unclaimed id;
- then checked the staff list. **It ended as it started:** organizer, judge, scorekeeper.

The 13 calls are sanitized fixtures in `server/modules/pokemon/adapters/play-tools/__fixtures__/s6/` (`NN.METHOD.path.json`).
Fixture 12's id is pseudonymised. It was really `0`.

**Write contract (confirmed).** All paths are under `https://api.play.pokemon.com/services/`. Upstream accepts
paths without a trailing slash.

| Call | Request | Response |
| ---- | ------- | -------- |
| Assign | `POST core/tournaments/{t}/records` `{"role","player":false,"participant":{"player_id"},"origin":"manual"}` | **201 `{"guid": <new record guid>}`**. A re-added staffer gets a new record guid. |
| Assign, already listed | same | **400** `{"code":"op.generic.bad_request","message":"Invalid request.","errors":{"body":{"participant.player_id":[{"code":"op.activity_record.cannot_duplicate_participant","message":…}]}}}` |
| Assign, unclaimed or non-existent id (`0`) | same | **400**, same envelope, code `op.activity_record.player_id_must_be_claimed` (not `unknown_reference`) |
| Change role | `PATCH core/tournaments/{t}/records/{r}` `[{"op":"replace","path":"/role","value":…}]` | **204**, empty |
| Remove | `DELETE core/tournaments/{t}/records/{r}` `[{"legacy_alias":"<player_id>"}]` | **204**, empty |

- The error key is the dotted string `"participant.player_id"`, not an index like `_bulk`'s `"0.participant.player_id"`.
  One call carries one staffer, so there is nothing to index.
- `judge` → `administration` → `judge` was accepted for a certified judge.
- **The edit window is enforced upstream** (`pnpm spike:s6-cert`, fixtures 19–22). Adding a TCG-certified person
  as `judge` to a TCG tournament 117 days after its start → **423 `cannot_modify_old_activity`**. Nothing was
  added, and the staff list matched its snapshot.
  - The exact cut-off wasn't probed. The UI uses start + 90 d, and a tournament 25 days old was still editable.
  - The app should treat 423 as "this tournament is locked": stop the job for that tournament, and offer only
    tournaments inside start + 90 d.
  - Removing or re-roling staff on a locked tournament was **deliberately not tried**. If only adds were locked,
    a removal couldn't have been undone.
  - **Assumption (organizer, 2026-10-11): a tournament past its window is locked to every change.** Add, role
    change and remove are all refused. The app treats it as read-only, offers no staff actions on it, and expects
    423 from any write.
- **Certification is per product, and upstream enforces it** (`pnpm spike:s6-cert`, fixtures 14–18).
  - The person tested is TCG-certified only, chosen by the organizer.
  - Adding them to a VGC (`product: "vg"`) tournament as `judge` → 400 `missing_certification`, and as
    `headjudge` → the same.
  - Nothing was added, and the staff list matched its snapshot afterwards.
  - The app needs no certification rules of its own. It reports this code per staffer, for example "not certified
    for this role at a VGC event".

**Reads (confirmed).**

- **`GET core/tournaments/{t}/records`** is DRF-paged. The envelope is `count`, `next`, `previous`,
  `standings_upper_bound` and `player_count`.
  - **Unfiltered**, it returns players *and* staff together: 4 players + organizer + judge + scorekeeper = 7, paged
    by `next`. One unfiltered pass over every page is therefore the "is this id already listed" check (ADR-0007).
  - `player=true` gives players (`role: null`). `player=false&role:null=false` gives staff.
  - **Record:** `guid`, `role`, `player`, `participant {guid, player_id, display_first_name, display_last_name,
    year_of_birth, user {guid, country}}`, `division`, `actual_division`, `result`, `match_results`, `origin`
    and `status`.
- **`GET core/tournament/{t}`** (singular) gives `organizer {guid, player_id, first_name, last_name, country,
  display_name}`. That is the organizer check.
  - It also has `start_date_actual` (UTC), `report_date`, `status`, `activity_state` and `category` (e.g. `pgo_std`).
  - Its `player_count` is per division (`{"all": 4, "unknown": 11}`).
- **`GET core/activities?type=tournament&role=organizer&sort_by=-start_date`** pages through the organizer's
  tournaments (117 here), newest first, including upcoming ones.
  - **It ignores `start_date_v2:*` filters.** With a one-day filter it still returned `count=117`, oldest first.
    The app must page through and filter by date itself, or stop paging once `start_date_v2` drops below the date.
  - **Row keys:** `guid`, `activity_type`, `name`, `display_id`, `product`, `start_date`, `start_date_v2`,
    `address`, `activity_group`, `activity_state`, `application_state` and `status`.
  - `status` was `sanctioned` for upcoming events, `complete` for finished ones and `cancelled` for cancelled ones.
- **`start_date` is local wall-clock time stamped `Z`.** A 2:30 PM CDT start is `14:30:00Z`, while `start_date_v2`
  is the true UTC (`19:30:00Z`). Always use `start_date_v2` (or `start_date_actual`).
- **Staffing a tournament grants no access to its staff list.** The first connect used the wrong account by
  mistake. That account was head judge on one of the organizer's tournaments:
  - its `GET core/tournament/{t}` → 200;
  - its `GET core/tournaments/{t}/records?player=false` → **403**;
  - its `core/activities` held only the tournaments it organizes, whether or not `type`/`role` was sent.

  Staff management is organizer-only. The app should offer only tournaments from `core/activities`.
- `core/users/{sub}/activities` (the staffing history) lists every tournament the caller is on, in any role,
  with `record.role`, and it *does* honour the `start_date_v2` filters. The app doesn't need it.

**Answers to the S6 questions.**

1. **Calls:** see the write contract table.
2. **Tournament list:** `core/activities` (organizer's own, client-side date filter on `start_date_v2`).
3. **Roles:** the bundle constant `judge`, `headjudge`, `scorekeeper`, `administration` (Support Staff) and
   `translator`.
4. **Already listed:** an unfiltered records pass, every page, before each assign. Upstream refuses a duplicate
   anyway (`cannot_duplicate_participant`).
5. **Organizer:** `organizer.player_id` in the tournament details.
6. **Edit window:** the UI allows adding until start + 90 d. Upstream refuses an add on a 117-day-old tournament
   with 423 `cannot_modify_old_activity`.
   Certification is enforced upstream per product (`missing_certification`). Map any 400 code to a per-staffer failure.

**Still open (low risk):**

- the exact cut-off (the UI says start + 90 d). `PATCH`/`DELETE` on a locked tournament are *assumed* refused, by
  the organizer's call; not tried.
- whether `DELETE` without the `legacy_alias` body works.

**Result:** fill in the gateway contract in architecture §4.3, settle ADR-0007's open questions, and add the
routes to `test/server/fake-pokemon.ts`. This is for #41's owner, as the ADR is still a proposal.

### S8: tournament lifecycle and TDF upload (part 1 done 2026-10-12)

This decides the tournament methods on `PlayToolsGateway` for M9 ([ADR-0010](adr/0010-tournament-templates-and-lifecycle.md),
[ADR-0011](adr/0011-tdf-results-upload.md)). Nothing in M9 that writes upstream is built until part 2's fixtures exist.

1. **Bundle analysis.** Done 2026-10-12, no login, same method as S6 part 1. The public play-tools SPA
   (`assets/index-CnpuJCUp.js` and 97 lazy chunks) is still Istanbul-instrumented. The chunks that matter:
   `TournamentService` (in `index-CnpuJCUp.js`, sha256 `0eec17da7d9f…`), `TournamentCreation` (`index-z4Jq0EdG.js`
   and the step chunks), `TournamentConfirmation` + `toApiTournamentPayload` (`index-CYarp5OL.js`) and
   `TournamentDetail` (`index-DmdtsX0M.js`, `index-DUXOMxqq.js`). Findings below; *(inferred)* marks claims the
   bundle doesn't show directly.
2. **Live capture.** Done 2026-10-13 with `pnpm spike:s8-live` ([part 2](#part-2-live-capture-2026-10-13)).

**Calls.** All are under `https://api.play.pokemon.com/services/`, JSON, `Authorization: Bearer …` only.

| Action | Call | Body / result |
| ------ | ---- | ------------- |
| Create | `POST core/tournament` | See the body table. The response has at least `guid` (the UI navigates to it). |
| Edit | `PATCH core/tournament/{guid}/` | Same body and adapter as create. |
| Cancel | `PATCH core/tournament/{guid}/` | `{"application_state":"cancelled"}`. No reason field. |
| Delete, un-cancel | same | `"deleted"` / `"sanctioned"`: **admins only**. An organizer can cancel, not delete. |
| Series for a league | `GET core/users/{sub}/activity_groups/{ag}/series/` | `[{guid, name, product, category_slugs, schedule: {<country>: {start_date, end_date}}}]` |
| Products, formats | `GET core/products?country=XX` | `results` (product codes) + `product_categories[product]` (category slugs) |
| Venues | `GET core/v2/users/{organizerGuid}/address_book?country=&activity_group_id=` | `{guid, name, formatted_address, country, op_country, timezone, source}`; the league's own first |
| Play cycle | `GET api/epoch/cycle` | `[{start_date, end_date, league_start_date, league_end_date}]` |
| TDF validate | `POST triumph/tdf/` | `{"kind":"tdf","tournament_id":"<display_id>","payload":"<base64 .tdf>"}` → `{upload_guid, errors: [code]}`. Behind the `triumph-scalability` flag the file goes to a presigned URL and `POST triumph/upload/{key}/$process/` instead. |
| TDF confirm | `PUT triumph/{upload_guid}/confirm/` | `{"tournament_id": …}`: the tournament `guid` from the TDF modal, the `display_id` from the standings tab (**the two disagree**) |
| Upload history | `GET triumph/tournament/{display_id}/uploads/` | `kind`, `accepted`, date, `version_complete_synced` |

**Create body** (`toApiTournamentPayload`): `name` (≤ 80, no emoji), `activity_group_id`, `organizer_id` (user
guid), `product` (`tcg`/`vg`/`pgo`), `category` (e.g. `tcg_std`, `vg_mod`), `series_guid` (premier series, or
`null` for a custom event), `address_id` (address-book guid), the start date, `contact_information {email, phone}`
(one required), `details` (≤ 30,000), `event_website`, `third_party_registration_website`, `on_site_admission`,
`registration_start_date_v2`/`registration_end_date_v2`, `activity_division_info` (per-division times and costs, or
`null`). Never sent: `divisionless`, `play_template`, `status`, `display_id`.

**Dates depend on a remote flag** (`play-pokemon-program-configuration`). On: `start_date_v2` is the wall-clock time
read in the **venue's** timezone and sent as UTC (fallback `America/Los_Angeles`). Off: `start_date` is the naive
local string, plus `on_site_registration_datetime_full` and `on_site_registration_duration` (minutes). Which one
production uses isn't visible.

**Rules the client enforces** (the server's own are unknown):

- A start date may be up to 72 h in the past (the code allows 84 h). There is **no lead time** and no per-day limit.
- The latest date is the end of the series' window for the venue's country (premier), or of the play cycle (custom).
- A premier series limits `category` to its `category_slugs`. A professor editing can't change the league, the event
  type or the series.
- Edit and cancel close at `start_date_actual + 90 d` (as for staff, S6). Cancel needs `application_state` in
  `sanctioned`, `approval-pending`, `sanctioning-error` and `activity_state` not `completed`. A tournament **can be
  cancelled after its start** inside the window.
- The create route has no client-side permission check. *(Inferred)* the server enforces the league-assistant roles.

**Statuses.** `application_state`/`status`: `approval-pending`, `sanctioned`, `sanctioning-error`, `cancelled`,
`deleted`, `complete`, `invalidated`. `activity_state`: `pending` → `upload_in_progress` → `completed` or
`upload_failed`. *(Inferred)* the server decides whether a new tournament starts `approval-pending`.

**Clone, not templates.** play-tools' Clone only pre-fills the create form (no call). It copies the league, admission,
details, contacts, event type, registration type and website, and **not** the name, date, series or registration
times. There is no template or recurrence for tournaments upstream (recurrence exists only for play sessions).

**TDF upload rules** (client):

- Only the organizer (or an admin) may upload, while `application_state == sanctioned`, `activity_state == pending`,
  `status != complete`, within start + 90 d, and **only while the tournament has no player records**. There is no
  "after the start" check.
- An organizer can't re-upload: once players exist, only an admin purge (`DELETE core/tournament/{guid}/players`) resets it.
- The file must match the tournament: `TDF_TOURNAMENT_ID_AND_PAYLOAD_ID_MISMATCH_ERROR`, `ORGANIZER_ID_MISMATCH`,
  `GAMETYPE_PRODUCT_CODE_ERROR`. A TDF player already on the staff fails with `STAFF_PLAYERS_ERROR`.
- After confirm, play-tools says "TDF Uploaded. Awaiting sync." and the tournament ends `complete` or
  `upload_failed`. The client doesn't poll.
- Codes the UI translates: `TDF_TOURNAMENT_ID_AND_PAYLOAD_ID_MISMATCH_ERROR`, `PLAYER_IDS_CHECK_ERROR`,
  `INVALID_PLAYER_IDS_ERROR`, `STAFF_PLAYERS_ERROR`, `MERGED_PLAYER_IDS_ERROR`, `DUPLICATE_PLAYER_IDS_ERROR`,
  `PLAYER_COUNT_MISMATCH_ERROR`, `MISSING_PLAYERS_FROM_STANDINGS_ERROR`, `MISSING_PLAYERS_FROM_ROSTER_ERROR`,
  `MISSING_STANDINGS_ERROR`; dozens more are only title-cased (`INVALID_XML_ERROR`, `TOURNAMENT_NOT_SANCTIONED_ERROR`, …).

**Errors on create, edit and cancel** have no translated `op.*` codes. The UI shows a generic message and the
`x-correlation-id` header.

**Open questions for part 2** (live capture):

1. Is `play-pokemon-program-configuration` on (`start_date_v2` in UTC) or off (naive `start_date`)?
2. `POST core/tournament`: status code, full body, initial status of a custom vs. a premier-series event.
3. Does a professor's `PATCH` of the date work, or does it invalidate or re-queue the tournament? Does it accept a
   partial body? Record a full read with every field set (non-null `activity_division_info` included) for the
   edit-body contract test. ADR-0010 decision 8 edits the date in place; cancel + recreate is only the fallback if
   the `PATCH` is refused (ADR-0010 Q1, #100).
4. What does the server refuse that the client doesn't (back-dating, overlaps, series quotas), and with what envelope?
5. Cancel's status code; cancel by a non-organizer; cancel during a TDF upload.
6. TDF: is `triumph-scalability` on; the exact `triumph/tdf/` response; the shape of `errors`; whether confirm
   takes the `guid` or the `display_id`; the size limit; how long `upload_in_progress` lasts; whether an upload
   before the start date is accepted; how long an unconfirmed `upload_guid` stays valid.
7. What the league assistant roles (Enhanced, Specialist) may create, cancel and upload.

#### Part 2: live capture (2026-10-13)

This ran with `pnpm spike:s8-live` (#85) against the organizer's league, from the organizer's own login, with their
go-ahead before every write. The organizer chose the actions:

- **One tournament**, created for the spike: a TCG custom event starting 24 h in the past. It was edited and
  restored, then got a phony TDF the organizer built (4 Masters).
- **A real cancel:** a 2026-09-01 event that never happened.
- **Not covered:** a premier event, and edits before a start.

The 42 calls are sanitized fixtures in `server/modules/pokemon/adapters/play-tools/__fixtures__/s8/`
(`NN.METHOD.path.json`, in the order they ran). The sanitizer also redacts:

- the TDF, as `{tdf, bytes, gametype, elements}`;
- venue location fields;
- player ids inside messages;
- the league's display id;
- every real id the run collected.

**Write contract (confirmed).** All paths are under `https://api.play.pokemon.com/services/`.

| Call | Request | Response |
| ---- | ------- | -------- |
| Create | `POST core/tournament`: name, `activity_group_id`, `organizer_id` (the user guid, the same as the token's `sub`), `product`, `category`, `series_guid: null`, `address_id`, `start_date_v2` (UTC), `contact_information`, `activity_division_info` | **201 `{"guid"}`**, nothing else |
| Create, `activity_division_info: null` | same | **400** `{"code":"op.generic.bad_request","message":"Invalid request.","errors":{"activity_division_info":["This field may not be null."]}}`. `errors` is keyed by field **directly**, not under `errors.body` as for staff |
| Edit (partial body) | `PATCH core/tournament/{guid}/` `{"details": …}` or `{"start_date_v2": …}` alone | **204**, empty. Only that field changes: the other 32 fields read back identical. `version` goes up by 2 per PATCH |
| Cancel | `PATCH core/tournament/{guid}/` `{"application_state":"cancelled"}` | **204**, empty. Reads back `application_state: "cancelled"`, and `core/activities` shows `status: "cancelled"` |
| TDF validate | `POST triumph/tdf/` `{"kind":"tdf","tournament_id":<display_id>,"payload":<base64>}` | **200** `{name, id, upload_guid, player_count, start_date, product, errors: []}`: a preview read from the file |
| TDF confirm | `PUT triumph/{upload_guid}/confirm/` `{"tournament_id": <tournament guid>}` | **202**, accepted at once; the `display_id` form wasn't needed |

- **`activity_division_info` is required.** The organizer's own tournaments send `{"juniors":null,"masters":null,"seniors":null,"all":null}`
  (one empty entry per division), and so did the create that worked. The bundle sometimes sends `null`; the server refuses it.
- **Dates:** production takes `start_date_v2` in UTC. The read gives `start_date_v2` and `start_date_actual` in UTC,
  and `start_date` as local wall-clock time stamped `Z`, as S6 found.
- **A date PATCH carries through:** moving `start_date_v2` by 1 h moved `start_date_actual` and the local `start_date`
  with it.
- **`details` is trimmed** (`" ."` was stored as `"."`). Setting it back to `""` leaves `""`, not the original `null`.

**Statuses.**

- **A new custom event is `sanctioned` straight away**, with `activity_state: "pending"` and no approval step. A
  premier event's initial status is **not tried**.
- **A date change after the start kept it `sanctioned`:** it wasn't sent back for approval. A date change before
  the start is not tried.
- **After a confirmed upload,** the tournament reads `status: "complete"`, `activity_state: "completed"` and
  `application_state: "sanctioned"`, with `player_count` per division and `report_date` set.

**Server refusals (part 1 question 4).**

- **Back-dating by 24 h was accepted.** Larger back-dating, overlaps and series quotas were not probed.
- **The refusal envelope** is the one shown above: `op.generic.bad_request`, with field errors keyed by field name.

**Cancel (question 5).**

- 204, as above.
- **Allowed 42 days after the start**, for an event still `sanctioned`/`pending`.
- Cancel by a non-organizer, and cancel during an upload, were not tried.

**TDF (question 6).**

- **The plain path works.** `POST triumph/tdf/` then `PUT …/confirm/` succeeded, so whatever `triumph-scalability`
  says, the plain path is live for organizers. The presigned-URL path wasn't needed.
- **Validate is a preview.** Its response echoes the file's `name`, `id`, `start_date` (`MM/DD/YYYY`), `product` (the
  file's gametype, e.g. `TRADING_CARD_GAME`) and
  `player_count`, plus `errors`.
- **Validate does not compare dates.** The file's start date was a day off from the tournament's, and validate
  still returned no errors.
- **`errors` is a list of `{type, message}`**, from upload history, e.g. `{"type":"ORGANIZER_ID_MISMATCH","message":"<id> !== <id>"}`.
  The message names player ids.
- **Confirm takes the tournament `guid`** (202). The display-id form wasn't needed.
- **`upload_in_progress` is short.** At most about 15 s: confirm returned at 06:09:35Z, and the first read after it
  (06:09:50Z) was already `completed`. Watching every 30 s is more than enough.
- **Upload history:** `GET triumph/tournament/{display_id}/uploads/` returns a **bare list** (not paged) of
  `{guid, tournament_id, kind, accepted, errors, uploader, upload_timestamp (ms), upload_expiration (s)}`.
  - Rejected validations are listed too, with `accepted: false`.
  - `upload_expiration` is the upload time + 390 days. That looks like retention, not a confirm deadline.
  - How long an unconfirmed upload stays valid was not probed.
- **An organizer can't download a TDF.** `GET triumph/tdf/{upload guid}` → **403** `{"code":"op.generic.forbidden","message":"Request not
  authorized for attempted action."}`. That held for two older uploads, and for the one this run had just made
  through the API.
- **Not probed:** the size limit, and an upload before the start date.

**Reads.**

- **`core/products?country=US`** returns `{results: ["pgo","tcg","vg"], product_categories: {tcg: [7], vg: [4], pgo: [3]}}`.
  - The category lists are plain strings: `tcg_std`, `tcg_exp`, `tcg_glc`, `tcg_lim`, `tcg_lim_ditto`, `tcg_unl`,
    `tcg_other`; `vg_mod`, `vg_fun_sin`, `vg_fun_multi`, `vg_fun_other`; `pgo_std`, `pgo_limited_meta`, `pgo_other`.
- **Series** (`GET core/users/{sub}/activity_groups/{ag}/series/`) are paged under `results`. Each has
  `category_slugs`, `tags` (`league_challenge`, `league_cup`, `prerelease`, `championship_series`), a
  `play_template` (`LEAGUECHALLENGE`, `TCG1DAY`, `VGCPREMIER`, `PRERELEASE`) and a per-country `schedule`.
  - **Windows are monthly** for TCG, VGC and GO League Challenges (2026-11-01 → 11-30).
  - TCG also has a 09-01 → 11-30 window, which is quarterly, and a 10-24 → 11-01 prerelease window.
- **The address book** is paged under `results`. The league's own entry has `timezone` and `op_country`.
- **`api/epoch/cycle` is 404** under `services/`. The play cycle lives on another base; nothing in M9 needs it yet.
- **Tournament detail** has 34 fields, including `play_template`, `divisionless`, `series`, `allowed_age_divisions`,
  `on_site_admission` and `version` / `version_complete` / `version_complete_synced`.

**Answers to the part 1 questions.**

1. **Date format:** `start_date_v2` (UTC). The flag is effectively on.
2. **Create:** 201 `{guid}`. A custom event starts `sanctioned`; premier is not tried.
3. **Edit:** a partial `PATCH` works and changes only the fields sent. A date change after the start stays
   `sanctioned`. Reschedule can edit in place (ADR-0010 decision 8). The full-body passthrough of decision 11 isn't
   needed to avoid wiping fields, though it does no harm.
4. **Refusals:** `null` division info → 400 with field errors; 24 h back-dating is accepted. The rest is not tried.
5. **Cancel:** 204, allowed after the start. Non-organizer and during-upload are not tried.
6. **TDF:** plain path; `errors: [{type, message}]`; confirm by guid → 202; `upload_in_progress` lasts seconds;
   **no organizer download**. Size limit and before-start upload are not tried.
7. **Assistant roles:** not tried; that needs a second account.

**Still open:**

- the TCG and VGC `gametype` spellings in real files. The download is 403, so the phony TCG file used
  `TRADING_CARD_GAME`. Validate accepted it for a `tcg` tournament, echoing `product: "TRADING_CARD_GAME"`.
  VGC is unconfirmed.
- a premier event's initial status;
- edits before a start;
- larger back-dating;
- the size limit;
- the confirm deadline;
- assistant roles.

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
