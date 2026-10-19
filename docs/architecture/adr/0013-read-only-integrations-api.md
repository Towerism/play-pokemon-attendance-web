# ADR-0013: A read-only integrations API, authenticated by bearer tokens

- Status: Accepted (2026-10-13, #115)
- Date: 2026-10-13
- Amends: architecture §7 ("every handler calls `requireUserSession`") and the CLAUDE.md module rule saying the same,
  for one route family: `/api/integrations/v1/*`
- Amended by: [ADR-0015](0015-professor-logins.md) (proposed, #199): tokens carry scopes checked per route, and a low-level Discord message channel (scope `messages:deliver`), which Genie long-polls, sends professors direct messages addressed by player ID
- Companion: [Tournament Genie ADR-0008](https://github.com/Towerism/discord-pokemon-tournament-genie/blob/main/docs/architecture/adr/0008-attendance-integration.md)
  (accepted), which fixes the contract and pulls on the organizer's click
- Builds on: [ADR-0007](0007-staff-assignment.md) (staff assignments are desired state),
  [ADR-0009](0009-tournaments-as-their-organizer.md) (each tournament read as its organizer, every connected professor)

## Context

Tournament Genie sets up a store's Discord channels for an event day. It needs the day's tournaments and the staff
assigned to them, which the organizer already keeps here. Genie is a separate server on the same LAN (usually the
same Unraid box). It must never call play-tools itself, and it can't hold an organizer's browser session.

Every `/api` route so far needs the organizer's sealed session cookie. That suits the browser, but no other program
can use it: a cookie login would mean handing Genie the organizer's password.

What makes Genie's import dangerous is a **false "gone"**. Its refresh removes staff's channel access when one of
its events no longer comes back. If a professor's login has lapsed and this app answered as though their
tournaments were cancelled, accepting that refresh would lock staff out on the day.

## Options considered

1. **A versioned read-only route with bearer tokens minted in Settings (chosen).** Each token is shown once and
   stored as a hash. It is scoped to `/api/integrations/v1/*` and can be revoked.
2. **Give Genie an app login.** Genie would get the organizer's whole app (writes included) and a password to
   store, and the scrypt cost of logging in on every call.
3. **Push to Genie on change.** This app would have to know Genie, hold its credentials and retry deliveries
   (Genie's ADR-0008 rejected this).
4. **Share the database file.** That couples both apps' schemas and breaks the module rules.

## Decision

1. **One route family, outside the session rule.** `GET /api/integrations/v1/days/{date}` authenticates **only**
   with `Authorization: Bearer <token>` (`requireIntegrationToken`, `server/utils/integrations.ts`). A session cookie
   doesn't count there, and a token counts nowhere else. Every other route keeps `requireUserSession`.
2. **Tokens.** Each is `ppa_int_` plus 43 base64url characters (256 random bits), minted by the organizer in
   Settings → **Integrations**, labelled, and shown once.
   - Only its SHA-256 and a hint (`ppa_int_…` plus the last 4 characters) are stored, in `integration_token`, which
     the `integrations` module owns.
   - Lookup is by digest through a unique index: 256 bits of entropy make a slow hash pointless, and no comparison
     of secrets happens.
   - A league holds at most 10 tokens. Revoking deletes the row, so the secret stops working on the next call.
   - The one scope, `integrations:read`, is stored for the future but grants only this route family.
3. **Refusals look alike.** A missing, malformed, unknown or revoked token all get the same 401 `invalid_token`
   with `WWW-Authenticate: Bearer realm="integrations", error="invalid_token"`.
4. **Human-scale traffic.** Each day read goes to play-tools live, exactly as the This week Staff card does. A
   per-token fixed window (30 reads per 15 minutes; `NUXT_INTEGRATION_RATE_LIMIT_*`) answers 429 with
   `Retry-After` before any upstream call. There is no cache: Genie pulls on a click.
5. **The day is the Staff card's read, as a contract.** `StaffingService.daySnapshot` shares `sessionStaff`'s
   reads: every connected professor, one at a time and each as themselves, each tournament once, the league's
   only, starting on the date in the league `TZ`. The `integrations` module maps the snapshot to `AttendanceDayV1`
   (`shared/schemas/integrations.ts`):
   - `staff` are the live assignments, in their wanted roles. Staff present only in play-tools are left out.
   - `game` comes from a single known product, and is otherwise null.
   - The organizer is named by their display name here, or "Professor <id>".
6. **No false "gone".** `professors` lists every connected professor:
   - `read` only when every call for them succeeded.
   - Otherwise `unread`, with `needs_reconnect` or `read_failed`, and **none** of their tournaments, so Genie
     protects them all.
   - A connected professor still without a player ID (a legacy row) makes the whole day 503
     `professor_unidentified`, because Genie couldn't tell which events are theirs.
   - With no professor connected, the answer is an empty day.
7. **Read-only.** The route never writes to play-tools or changes assignments. Like the Staff card, it may seed
   the staff list from what it read (local `staff_history` and the names of players not known yet).
8. **Frozen v1.** The response is a strict Zod schema, and the server tests pin it to a recorded fixture
   (`test/server/__fixtures__/integrations-v1-day.json`) that Genie copies. Changes are additive, or go to `v2`.
9. **Audit.** Each successful read logs one `integration day read` line: token id and label, date, tournament
   count and unread professors. The `Authorization` header is already on the redaction list, and the secret is
   never logged. Responses are `Cache-Control: no-store`.

## Consequences

- (+) The organizer enters staffing once, and Genie imports every connected professor's tournaments in one call.
- (+) A lapsed login shows as `unread`, never as cancellations, so a refresh can't take away staff's channel access.
- (+) The token has the smallest power that works: one read-only route, revocable, no password to store.
- (+) The day logic is shared with the Staff card, so the two never disagree about which tournaments a date has.
- (−) A stolen token reads tournament names and staff names and player IDs until it is revoked. Over plain HTTP on
  the LAN it travels in clear, so remote access should go through the HTTPS reverse proxy or Tailscale (§9).
- (−) A day read costs live play-tools calls (1 listing per professor plus 2 per tournament). The rate limit caps
  a misbehaving client.
- (−) Staff added straight in play-tools don't reach Genie. Including them later is an additive v1 change (with a
  `source` field) that Genie would have to adopt.
- (−) A second way into `/api`. The route family is small and fully covered by the auth matrix in
  `test/server/integrations.test.ts`.

## Tests these decisions need

- **Pure:** the projection (games, names, every upstream error code → reason, dedupe, order, roles outside the
  contract, unidentified professors) and bearer parsing.
- **Module (real SQLite):** mint, list, revoke, authenticate, mark used, and the limit of 10.
- **Staffing:** `daySnapshot` per-professor outcomes, with `sessionStaff`'s tests unchanged.
- **Server, over HTTP:** the fixture deep-equal, the auth matrix, a token on other routes, the rate limit, the
  token routes' validation, reconnect and failure outcomes, GET-only upstream traffic, the audit line, and a secret
  sweep of every body and log.
- **E2E:** the token is shown once, then only its hint, a reload included, and revoking it works.
