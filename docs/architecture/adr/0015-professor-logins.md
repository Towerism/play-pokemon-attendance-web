# ADR-0015: Professor logins: each professor acts only through their own Pokémon connection

- Status: Proposed (2026-10-19, #199)
- Date: 2026-10-19
- Issue: [#199](https://github.com/Towerism/play-pokemon-attendance-web/issues/199)
- Amends:
  - [ADR-0008](0008-plural-pokemon-connections.md): the league no longer names one submitting professor; attendance
    goes in as the professor who clicks Submit.
  - [ADR-0009](0009-tournaments-as-their-organizer.md): the league is chosen from the owner's leagues, and a professor
    outside it is left out instead of blocking the choice.
  - [ADR-0013](0013-read-only-integrations-api.md): the integrations route family gains one write route, and tokens
    carry scopes that are enforced per route.
- Builds on: ADR-0008 option 4, which deferred plural app users to their own design.

## Context

The app has one login, created at first-run setup. Since ADR-0008 several professors' Pokémon accounts can be
connected, and every route only checks that *someone* is logged in. So whoever holds the login can submit
attendance, staff tournaments and create tournaments as any connected professor. In practice the organizer has had
to connect the other professors' accounts with their passwords.

The organizer's request (#199, 2026-10-19):

> architect a new feature that allows professors access to attendance. access will be limited to their own
> play-tools connection. every other connection will be read-only so that tournament scheduling still works, since
> multiple professors can split up the cups and challenges. additionally the owner account will have read-only
> access to other professors' connections. inter-account play-tools connections is only true if the connections are
> a part of the same league. a discord will be set up to DM invite links to professors.

Asked how it should work, they answered:

- **Owner:** "admin + see all. owner acts only through their own connections (however many connections they
  themselves setup). Other professors who are invited to the application only get access to create their one and
  only connection."
- **Leagues:** one league per install.
- **Invites:** attendance mints the invite links, and Tournament Genie (the store's Discord bot) sends them as direct
  messages, through a new, separately scoped integration endpoint.

Facts this relies on:

- `GET core/users/{sub}/activity_groups/` lists the leagues a professor's account belongs to, with their
  permissions in `criteria` (spikes S5, S7). The league picker already reads it for every connection.
- Upstream checks each call's permissions against the caller, so several professors can each submit to the same
  play session. The submission diff (ADR-0004) already treats records someone else added as `already_present`.
- Today's code records who did something only as the free-text username (`submission.started_by` and about ten
  other columns). No table has a foreign key to `app_user`.

## Options considered

1. **Shared login (status quo).** Every professor would need the organizer's password, and everyone could act as
   everyone.
2. **Roles on app users; each connection belongs to the user who connected it (chosen).** Writes to play-tools go only
   through a connection the signed-in user holds. League data is shared among league members.
3. **Per-feature permissions (an access-control list).** Flexible, but there are two kinds of people, owner and professor, and the
   rule that matters ("only through your own connection") is one check, not a matrix to configure.
4. **Sign in with Pokémon instead of a password.** The professor's Pokémon login would also be their app login.
   This removes a password, but each sign-in would be a PKCE (OAuth with a proof key) login at `access.pokemon.com`, and the app's session would
   depend on Pokémon being up. It could be added later as a second way to sign in.
5. **Sign in with Discord.** It ties the app to Discord and needs an OAuth app registration, which is a required
   setup step (ADR-0006 rules out required setup fields).

## Decision

Option 2.

### 1. Two roles

- `app_user` gains `role` (`owner` | `professor`) and `removed_at`.
- The first-run setup account is the **owner**. There is exactly one owner (a partial unique index), and the
  upgrade makes the existing account the owner. Moving ownership to someone else is out of scope.
- Everyone else is a **professor** and joins only through an invite (§5).
- A removed user can't sign in, and their username stays reserved, so the usernames in history keep meaning one
  person. The row is kept, not deleted.
- The role and `removed_at` are read from the database on every request, not from the sealed cookie. Removing a
  professor takes effect on their next request.

### 2. Every connection belongs to one user

- `pokemon_connection` gains `user_id`, a foreign key to `app_user`. It is set to the user who completed the connect, which
  already happens under that user's session (the PKCE attempt is bound to `user.id`).
- **A connection moves only from the owner to a professor.** A professor who completes a connect for a player ID the
  owner holds takes that connection over. The row, its display names and its league membership are kept, and the token
  is replaced (today's reconnect rule). This is how a professor takes back an account the owner connected for them
  under ADR-0008.
  - The move is recorded on the row (`claimed_from_user_id`, `claimed_at`) and in an audit log line. Settings →
    Professors shows it to the owner.
  - The professor is shown a prompt to change their Pokémon password, since the owner had it.
- Any other connect for a player ID someone else holds gets 409 `connection_held`, and the fresh login is revoked. This
  covers a professor taking another professor's connection, and the owner taking a professor's. Otherwise anyone who
  knows a professor's Pokémon password, the owner included, could quietly take that professor's place. The holder
  disconnects first, or the owner removes the holder (§6).
- A professor holds at most one connection. A professor who holds one and logs in as a different Pokémon account
  gets 409 `one_connection_only`, and the fresh login is revoked. Reconnecting their own account is allowed.
- The owner may hold several connections, within the install's budget (§5 "Limits").
- A professor can disconnect only their own connection. The owner can't disconnect someone else's, but can remove a
  professor (§6), which revokes and deletes the professor's connection.
- **Names.** The display name (ADR-0008) is a local label, never sent to Pokémon, and the connection's user or the
  owner can change it. The **full name** is different: ADR-0011 decision 8 writes it into a TDF whose organizer is
  replaced, and that file is uploaded to play-tools. So only the connection's own user may change it.

### 3. League membership gates every league page

There is still one league per install (`league = 'default'`).

- `league_upstream` loses `connection_id`. It keeps only the activity group, chosen by the owner from the leagues of
  the **owner's own** connections. ADR-0009's "leagues every connected professor shares" rule is dropped: a professor
  outside the league no longer blocks the choice.
- A new `league_membership` row per connection says whether that professor's Pokémon account is in the league's activity
  group:
  - `member`: the last successful read of their activity groups included it. It also stores `can_submit`
    (`criteria.play_sessions.create_attendance`).
  - `outside`: a successful read didn't include it.
  - `unknown`: not read successfully yet. A connect and a league change both reset the row to `unknown` before the
    read.
- When it is read:
  - at connect;
  - for every connection, one at a time, when the owner changes the league;
  - by the hourly keep-alive, after the refresh, for a connection last checked ≥ 24 h ago.
- A failed read never changes the state. Only a successful read that lacks the group makes a connection `outside`.
  That keeps a play-tools outage from looking like a professor leaving the league.
- **A user is a league member** if they are the owner, or a professor whose connection is `member`. A professor
  with no connection, or one that is `outside` or `unknown`, sees only their own account and connection in
  Settings, with a line saying why. They may call only:
  - logout;
  - `GET /settings`, cut down to their own account;
  - `GET /pokemon/connections`, filtered to their own connection;
  - connect start and complete;
  - disconnecting their own connection, and changing its names.

  The API answers every other route with 403 `not_a_member`.
- "Read-only access to other professors only within the same league" follows from this: a professor outside the
  league sees nobody, and nobody sees them.
- Reads across professors (This week's Staff card, Upcoming, Required events, imports, the integrations day) use
  every connection that is not `outside`.

This gate is also what makes Discord delivery acceptable. A leaked invite link gets someone an account and nothing
more, until a Pokémon account in this league is connected to it.

### 4. Who may do what

**Principle:** league members share the league's local data. A write to play-tools goes only through a connection the
signed-in user holds. Local state that is an instruction to write in a particular professor's name belongs to that
professor's user.

| Action | Owner | Professor (member) |
| --- | --- | --- |
| Read every page: This week, sessions, players, regulars, metrics, history, tournaments, required events | ✓ | ✓ |
| Edit league data: session players, TDF import, regulars, player names and notes, staff-list names, scaffolds, schedules, required-event covers | ✓ | ✓ |
| Submit attendance | as one of their own connections | as their own connection |
| Undo or retry a submission | only if it ran as one of their connections | only if it ran as theirs |
| Clear a play session (removes everyone's records) | ✓, as one of their connections | — |
| Staff a tournament: add, re-role, remove, apply; Results (TDF upload) | only tournaments they organize | only tournaments they organize |
| Templates: create or edit; create, edit or cancel a tournament from one | only with one of their connections as organizer | only with their own connection as organizer |
| Planned tournaments: skip, move, acknowledge (`PATCH /planned-tournaments/{id}`) | only if the template's organizer is one of theirs | only if the template's organizer is theirs |
| Batch routes spanning organizers (`staff/apply-all`, `POST /tournaments/create`, `create-through`) | each row runs only if its organizer is one of theirs | each row runs only if its organizer is theirs |
| List stored TDFs; download or delete one (holds minors' birthdates; re-checks of results need the file) | ✓ | only files they uploaded, or of tournaments they organize |
| Connect, reconnect, disconnect a Pokémon account | their own (several) | their own (one) |
| Change a connection's display name | any | their own |
| Change a connection's full name (written into TDFs sent upstream) | their own | their own |
| Pick the league; curation thresholds; staff and player import; integration tokens; invites; remove a professor; Settings → Professors (every professor's account, connection status and membership) | ✓ | — |

- **Batches across organizers.** A batch starts for the rows the user may act on. Every other row is refused as
  `not_your_connection`, with the organizer named, the same way a row is refused today for `organizer_not_connected`.
  A batch with no row the user may act on gets 403 `not_your_connection`.
- **"Tournaments they organize"** always means the organizer play-tools reports for the tournament, read as today
  (ADR-0009). It never means the `<organizer>` element in a TDF, which comes from the uploaded file.

- **Attendance as yourself.** Submit runs as the clicking user's connection, which must be `member` with
  `can_submit`. With one such connection there is nothing to pick. An owner with several picks one in the Submit
  dialog ("Submit as"). The job records that professor (as today), and **undo and retry run as the professor the
  submission ran as**, not as whoever is bound now. That fixes a gap where an undo could run as a different
  professor than the one who added the records.
- **Attendance reads** (the play-session resolver, the clear preview, the resolver inside the submit, undo and
  clear jobs) need a connection now that the league no longer names one:
  - a job reads as the connection it runs as;
  - a request reads as the caller's connection if it is `member` and connected, the one chosen in "Submit as" for an
    owner with several;
  - otherwise it reads as any `member`, connected connection, lowest id first. These are reads of the league's own
    play sessions, which any member professor can see.

  The resolver's cache stays keyed by league and activity group and is shared by every user, because play sessions
  belong to the league, not to a professor. `can_submit` is checked per connection, when a submission starts.
- **One job at a time** stays per league (ADR-0004), whoever starts it. A second user gets 409
  `submission_running`. Batches stay at 20 players at least 10 s apart, across all users.
- **Tournaments someone else organizes** are read-only for everyone else: their staff card, results and template show
  "Only <professor> can change this". When no app user holds the organizer's connection, nobody can send anything
  upstream for it (409 `organizer_not_connected`, as today). The owner may still delete its local pending staff
  rows and edit its template, so stale plans can be cleaned up.
- **Clear session is owner-only** because it removes records other professors added. Undo removes only what one
  submission added, so its professor can do it.
- Scaffolds and schedules stay shared: they only arrange templates, and nothing reaches play-tools until a
  template's organizer clicks Create.

**Where it is enforced.** Handlers get an `Actor` (`{ userId, username, role }`) from new guards in
`server/utils/access.ts`, which replace `requireLeague`:

- `requireActor(event)`: `requireUserSession`, then the user row. Missing or removed → 401, and the session is
  cleared.
- `requireMember(event)` → `{ leagueId, actor }`, or 403 `not_a_member`.
- `requireOwner(event)` → 403 `owner_only`.

Services that write upstream take the `actor` and get their connection from one place, the pokemon module's
`actingConnection(actor, professorPlayerId)`. It answers, in this order:

1. 409 `organizer_not_connected` when no connection has that player ID;
2. 403 `not_your_connection` (`data.professorPlayerId`) when another user holds it;
3. 409 `needs_reconnect` when it needs a reconnect;
4. otherwise, the connection id.

No other code turns a professor into a connection for a write. A job checks its starter once, when it starts. A
retry is a new start by whoever clicks it, so it is checked again. A job resumed after a restart keeps running as the
connection it recorded. If that connection was removed in the meantime, the job stops with `not_connected`.

### 5. Invites

- **Minting.** The owner mints an invite in Settings → Professors, with an optional label (≤ 60 characters, display
  only, e.g. the person's Discord name), or Genie mints one through the integrations API (below).
- **Shape.** The secret is `ppa_inv_` plus 43 base64url characters (256 random bits). The link is
  `<site URL>/invite#<secret>`. Because the secret sits in the URL fragment, browsers never send it to the
  server or a proxy, so it stays out of access logs and `Referer` headers. The page reads it and posts it.
- **Storage.** `app_invite` stores only the SHA-256 and a hint, looked up by a unique index, like integration
  tokens (ADR-0013). It also records the label, who minted it (a username or `integration:<token label>`), when, the
  expiry, and the user who accepted it.
- **Limits.**
  - An invite works once and expires after 72 hours. The owner can revoke it until it is used.
  - **One budget of 10** (`MAX_CONNECTIONS`, which today counts every connection): the owner's connections, plus
    active professors, plus unused, unexpired invites. Removed professors don't count. A mint that would exceed it
    gets 409 `invite_limit`, and an owner connect gets today's 409 `connection_limit`. So an invited professor always
    has a connection slot waiting.
  - A professor whose connection is `outside` still uses a slot. Settings → Professors flags them, and the owner
    removes them. Nothing is pruned automatically, because a play-tools listing can lag.
  - Connect attempts in flight are capped per user (2) as well as in total, so one account can't push out other
    users' attempts by starting connects over and over.
- **Accepting.**
  - `/invite` is public. It calls `POST /api/invites/check { secret }` to show the form, then
    `POST /api/invites/accept { secret, username, password }` (a reset link takes no username).
  - Accepting creates a professor, with the same username and password rules as setup, and marks the invite used,
    in one transaction. It signs the new professor in and opens Settings to connect their Pokémon account.
  - Unknown, expired, used and revoked invites all get the same 404 `invite_invalid`.
  - Both routes are limited to 5 per 15 minutes per client (`NUXT_INVITE_RATE_LIMIT_*`), checked before the body is
    read, like setup.
  - Someone who is already signed in gets 409 `already_signed_in`.
- **Where the link points.** Invite links use the existing optional `NUXT_PUBLIC_SITE_URL` (`docs/deploy/unraid.md`,
  already used for HSTS and Secure cookies), so the link and the cookies agree. No new setting is added. Without it,
  a link minted in Settings uses the browser's own origin, and Settings says the link only works where that address
  does (often only on the LAN). Genie's route has no browser origin to fall back on, so it needs the site URL: 409
  `site_url_not_set` without it.
- **Logging.** Invite secrets and links are never logged or shown again after minting. `inviteUrl` and
  `inviteSecret` join the redacted log keys.

**Genie (amends ADR-0013).**

- Integration tokens carry scopes chosen when they are minted: `integrations:read` (today's day route) and the new
  `invites:create`. Existing tokens keep `integrations:read` only.
- A route checks its own scope. A token that lacks it gets 403 `insufficient_scope`, with
  `WWW-Authenticate: Bearer realm="integrations", error="insufficient_scope"`.
- `POST /api/integrations/v1/invites { label }` → 201 `{ id, url, expiresAt }`. It is limited to 10 per hour per
  token, and subject to the invite limit.
- The route family is still bearer-only, and a token still counts nowhere else. Genie gets no way to list, revoke
  or accept invites, or to see users.
- On Genie's side, a Discord command that only the server's admins can use names a member. Genie mints the invite with
  the member's display name as the label, sends the link to that member as a direct message, and never posts or logs
  it. That is a companion decision for Genie's own ADR. Attendance never learns Discord IDs.

### 6. Managing professors (owner)

- Settings → **Professors** lists every professor:
  - username, connection ("Display name (player id)"), membership state, connection status, last sign-in;
  - outstanding invites (label, minted by, expires), with **Revoke**;
  - **Invite professor**, and **Reset password** on each professor, which show the link once, with a copy button;
  - connections moved from the owner to a professor, with when.
- **Remove** marks the user removed, revokes and deletes their connection (its league membership goes with it), and
  ends their access on the next request.
  - Their history stays, under their username and player ID.
  - Templates naming them as organizer stay, but can't create anything until someone connects that account again.
  - A job of theirs that is running stops at its next upstream call (`not_connected`), like any mid-job failure, and
    reconcile settles what was sent (ADR-0004).
- **Password reset.** A professor who forgot their password gets a **reset link** from the owner: an `app_invite` row
  with `for_user_id` set, the same secret, lifetime and single use. Accepting it sets a new password on that account
  and keeps the username, connection and history. It isn't counted in the budget, because it adds nobody. The owner
  resets their own password as today (outside this design).

### 7. Data and upgrade

- Forward-only migration:
  - `app_user.role` (existing account → `owner`) and `removed_at`;
  - `pokemon_connection.user_id` (every existing connection → the owner);
  - `league_membership`: the connection bound in `league_upstream` is seeded `member`, with `can_submit` from
    `activity_group_can_submit` and `checked_at` null. Every other connection is seeded `unknown`. The first
    keep-alive after boot checks every row whose `checked_at` is null;
  - `league_upstream` rebuilt without `connection_id`;
  - `app_invite` (with `for_user_id` for reset links);
  - `pokemon_connection.claimed_from_user_id` and `claimed_at`;
  - `integration_token.scopes`, existing rows → `integrations:read`.
- **After the upgrade, the owner can do what they could before.** They hold every connection, and the connection that
  submitted before is a `member` that can submit, so Submit works at once. One difference: Submit asks which of their
  connections to submit as once more than one is a `member` that can submit.
- **Module ownership:**
  - `accounts` owns `app_user` and `app_invite`, and exports the `Actor` type and the invite service.
  - `pokemon` owns `user_id`, `league_membership` and `actingConnection`.
  - `submission`, `staffing` and `tournaments` take an `actor` and never read either module's tables.
- **Rollback:** as ADR-0008. Stop the container, restore the pre-upgrade backup, and pin the previous image.

## Consequences

- (+) Each professor signs in as themselves, and nobody needs anyone else's Pokémon password.
- (+) The play-tools records each professor adds are under their own account, and History shows who.
- (+) Professors see the whole league's schedule, so they can split cups and challenges, while each tournament stays
  in its organizer's hands.
- (+) A leaked invite exposes nothing before a Pokémon account in this league is connected to it.
- (+) Undo and retry run as the professor who made the submission.
- (−) CLAUDE.md's key points and module rules must change with the implementation. They still say the league names
  the submitting professor, and that the league must be shared by every professor. They also say
  `/api/integrations/v1/*` is the only exception to the session rule, and the public `/api/invites/*` routes are a
  second one.
- (−) The owner loses the ability to act for a professor whose account moves to that professor's own login. That is
  intended, but the owner can no longer cover for an absent professor's tournaments.
- (−) An invite travels through Discord, which is a third party. The link's single use, 72-hour life and the
  membership gate limit what a copy is worth.
- (−) Every write path gains an authorization check, and every route an access test. The test matrix grows to
  three kinds of caller (owner, member professor, outside professor) per route.
- (−) Membership is up to 24 hours stale. A professor dropped from the league upstream keeps seeing the league for up
  to a day, but they still can't write to play-tools for it: upstream refuses them.
- (−) Each professor is one more keep-alive refresh an hour, within the existing cap of 10 connections.
