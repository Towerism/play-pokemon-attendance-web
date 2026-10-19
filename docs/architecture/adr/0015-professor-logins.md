# ADR-0015: Professor logins: each professor acts only through their own Pokémon connection

- Status: Proposed (2026-10-19, #199)
- Date: 2026-10-19
- Issue: [#199](https://github.com/Towerism/play-pokemon-attendance-web/issues/199)
- Amends:
  - [ADR-0008](0008-plural-pokemon-connections.md): the league no longer names one submitting professor; attendance
    goes in as the professor who clicks Submit.
  - [ADR-0009](0009-tournaments-as-their-organizer.md): the league is chosen from the owner's leagues, and a professor
    outside it is left out instead of blocking the choice.
  - [ADR-0013](0013-read-only-integrations-api.md): tokens carry scopes that are enforced per route, and the route
    family gains a message outbox that Genie pulls and acknowledges (§7).
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

Reviewing the first draft, they added (2026-10-19):

> the organizer of a tournament can lease one or more of their tournaments enabling a single named professor to be
> able to update staff and upload the TDF for said tournament. this enables the professor to utilize the connection
> belonging to the organizer of that tournament but only for that tournament specifically. the genie integration
> should be generic enough to be able to easily support sending any kind of messages to a specific discord user
> (identified by their player id, genie looks up the discord id, attendance does not need to know it).

Facts this relies on:

- `GET core/users/{sub}/activity_groups/` lists the leagues a professor's account belongs to, with their
  permissions in `criteria` (spikes S5, S7). The league picker already reads it for every connection.
- Upstream checks each call's permissions against the caller, so several professors can each submit to the same
  play session. The submission diff (ADR-0004) already treats records someone else added as `already_present`.
- Today's code records who did something only as the free-text username (`submission.started_by` and about ten
  other columns). No table has a foreign key to `app_user`.
- Play-tools has no way to let a second professor manage a tournament: staff management is organizer-only (spike S6,
  ADR-0009). Lending a tournament can only mean using the organizer's connection for it.
- Genie already maps player IDs to Discord accounts in its own directory (Genie ADR-0008, "Identity mapping is
  Genie's"). The same ADR rejected attendance pushing to Genie, because attendance would have to know Genie, hold its
  credentials and retry deliveries.

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

For lending a tournament (§5):

- **A lease per tournament, checked where the connection is chosen (chosen).** The lent professor gets the
  organizer's connection only for calls about that one tournament, and only for staff and results.
- **Lend the whole connection.** Simpler, but it would let the professor submit attendance and create tournaments as
  the organizer. The organizer asked for one tournament specifically.

For messages to Discord (§7):

- **An outbox Genie pulls and acknowledges (chosen).** Attendance queues a message for a player ID; Genie collects it,
  looks up the Discord user and sends a direct message. Genie keeps pulling, as in its ADR-0008, and attendance never
  needs Genie's address or credentials.
- **Attendance calls Genie's API.** Messages arrive faster, but this is the push Genie ADR-0008 rejected.
- **An invite-only route that Genie calls (the first draft).** It fits invites only, and every new kind of message
  would need its own route and its own Genie command.

## Decision

Option 2.

### 1. Two roles

- `app_user` gains `role` (`owner` | `professor`) and `removed_at`.
- The first-run setup account is the **owner**. There is exactly one owner (a partial unique index), and the
  upgrade makes the existing account the owner. Moving ownership to someone else is out of scope.
- Everyone else is a **professor** and joins only through an invite (§6).
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
  - Every lease the owner granted on that connection's tournaments ends (§5), since the owner no longer holds it.
- Any other connect for a player ID someone else holds gets 409 `connection_held`, and the fresh login is revoked. This
  covers a professor taking another professor's connection, and the owner taking a professor's. Otherwise anyone who
  knows a professor's Pokémon password, the owner included, could quietly take that professor's place. The holder
  disconnects first, or the owner removes the holder (§8).
- A professor holds at most one connection. A professor who holds one and logs in as a different Pokémon account
  gets 409 `one_connection_only`, and the fresh login is revoked. Reconnecting their own account is allowed.
- The owner may hold several connections, within the install's budget (§6 "Limits").
- A professor can disconnect only their own connection. The owner can't disconnect someone else's, but can remove a
  professor (§8), which revokes and deletes the professor's connection.
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

  The API answers every other route with 403 `not_a_member`. A professor who accepted a reset link and hasn't
  proved their Pokémon login since (§8) is held to the same routes, with 403 `reverify_required`.
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
| Staff a tournament: add, re-role, remove, apply; Results (TDF upload) | tournaments they organize | tournaments they organize, or hold a lease on |
| Lend a tournament to a named professor, or end the lease (§5) | tournaments they organize | tournaments they organize |
| Templates: create or edit; create, edit or cancel a tournament from one | only with one of their connections as organizer | only with their own connection as organizer |
| Planned tournaments: skip, move, acknowledge (`PATCH /planned-tournaments/{id}`) | only if the template's organizer is one of theirs | only if the template's organizer is theirs |
| Batch routes spanning organizers (`staff/apply-all`, `POST /tournaments/create`, `create-through`) | each row runs only if its organizer is one of theirs | each row runs only if its organizer is theirs |
| List stored TDFs; download or delete one (holds minors' birthdates; re-checks of results need the file) | ✓ | only files they uploaded, or of tournaments they organize; download only for a tournament they hold a lease on |
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
`actingConnection(actor, professorPlayerId, scope)`. `scope` is either `{ kind: 'own' }` (attendance, templates,
creating, editing and cancelling tournaments) or `{ kind: 'tournament', tournamentId, use: 'staff' | 'results' }`.
It answers, in this order:

1. 409 `organizer_not_connected` when no connection has that player ID;
2. the connection id, when the actor holds it (step 4 still applies);
3. the connection id, when the scope is a tournament and the actor holds a live lease on that tournament from that
   connection (§5). The answer says it is a lease, so the job records it;
4. 409 `needs_reconnect` when the connection it picked needs a reconnect;
5. otherwise 403 `not_your_connection` (`data.professorPlayerId`).

No other code turns a professor into a connection for a write. A lease never counts for an `own` scope, so a lent
tournament can't be used to submit attendance or create tournaments as its organizer. A job checks its starter once, when it starts. A
retry is a new start by whoever clicks it, so it is checked again. A job resumed after a restart keeps running as the
connection it recorded. If that connection was removed in the meantime, the job stops with `not_connected`.

### 5. Tournament leases

An organizer can lend one or more of their tournaments to one named professor. While the lease lasts, that
professor may staff the tournament and upload its results using the organizer's connection, for that tournament only.

- **Who.** The user who holds the organizer's connection grants and ends leases. The owner does this only for
  tournaments one of the owner's own connections organizes. The named professor must be a league member with the
  `professor` role. The owner is never lent a tournament, because the owner acts only through their own connections.
- **What a lease allows.** Every lease grants both uses below; `actingConnection` (§4) checks the call's `use`:
  - `staff`: the tournament's staff card: add, re-role, remove, apply, including its row in **Assign staff for all
    tournaments**;
  - `results`: the Results flow: preview and fixes, Remove from staff, send, recheck, Upload again, and downloading
    that tournament's TDF. A stored file belongs to the tournament through its results upload
    (`tournament_result_upload.tournament_id` and `tdf_file_id`); a file imported only for attendance (M3) isn't
    covered. A lent professor can't delete a stored file.

  Nothing else: not editing, rescheduling or cancelling the tournament, not its template, and not the organizer's
  full name. If the full name is missing, the lent professor is told to ask the organizer to set it. A lease never
  counts for attendance.
- **One named professor per tournament.** A tournament has at most one live lease. Lending it to someone else while
  one is live gets 409 `already_leased`; the organizer ends the old lease first. The organizer can still act on the
  tournament themselves.
- **Granting.** `POST /api/tournament-leases { tournamentIds, lesseeUserId, endsAt? }` lends one or more tournaments
  in one step, all or none:
  - each tournament is read fresh as its organizer, and must be organized by a connection the caller holds, be in
    the league's activity group, and not be cancelled;
  - each refusal names the tournament and its reason (`not_your_tournament`, `already_leased`, `unknown_tournament`);
  - `endsAt` defaults to the end of the 7th day after the tournament starts, in the league's time zone, and may be at
    most 30 days after it starts. It is fixed when the lease is granted. Rescheduling the tournament doesn't move
    it; the organizer ends the lease and lends the tournament again.
- **Listing and ending.** `GET /api/tournament-leases` lists the live leases the caller granted or holds (the owner
  sees all). `DELETE /api/tournament-leases/{id}` ends a lease when the organizer calls it, and gives it back when
  the lent professor does.
- **Ending.** A lease ends at the first of:
  - `endsAt`;
  - the organizer ending it, or the lent professor giving it back;
  - the lent professor being removed, or their connection turning `outside`;
  - the organizer's connection being disconnected, removed or moved to its professor (§2);
  - the tournament being cancelled through the app.

  An ended lease is kept with the time and the reason (`expired`, `ended`, `given_back`, `lessee_removed`,
  `lessee_outside`, `connection_gone`, `tournament_cancelled`), for History.
- **Jobs.** A staff or results job started under a lease records the lease, the lent professor as `started_by`, and
  the organizer as the professor it ran as. History shows "by <lent professor> for <organizer>". A leased job
  checks that the lease is still live when it starts, and then:
  - a **staff** job checks again before each staff write. If the lease has ended, it stops with `lease_ended`, and
    reconcile settles what was already sent (ADR-0004);
  - a **results** job checks once more before validating. Once play-tools has validated the file, the job always
    finishes its confirm. Ending a lease, or `endsAt` passing, never cuts an upload in two (ADR-0011).

  Staff writes stay one at a time, `NUXT_STAFF_DELAY_MS` apart.
- **What people see.** The lent professor's card is editable and says "Lent to you by <organizer> until <date>". To
  everyone else it says "Only <organizer> or <lent professor> can change this". The organizer and the owner see
  every lease.
- **Notice.** Granting and ending a lease each queue a message to the lent professor's player ID (§7), when Genie is
  set up. A lease that ends because the lent professor was removed sends nothing: they have no connection left.
- **Data.** `tournament_lease`, owned by the `pokemon` module beside `actingConnection`:
  - `connection_id` (ON DELETE CASCADE), `tournament_id` (the upstream GUID), a label for display, `lessee_user_id`;
  - `granted_by`, `granted_at`, `ends_at`, `ended_at`, `end_reason`;
  - a partial unique index on `tournament_id` while `ended_at` is null.

### 6. Invites

- **Minting.** The owner mints an invite in Settings → Professors. It takes an optional label (≤ 60 characters,
  display only) and an optional **player ID**, the invitee's Pokémon player ID.
  - With a player ID, the invite is bound to it: the professor it creates can only connect that Pokémon account.
    Any other gets 409 `invite_player_mismatch`, and the fresh login is revoked.
  - With a player ID, the owner can also choose **Send by Discord**. That queues an `invite` message to that player
    ID (§7), and Genie sends it to the Discord user it has on file for that player. Before sending, Settings shows
    the name the league knows for that ID and whether it is on the roster as a player, and the owner confirms.
  - Otherwise the link is shown once, to copy and send any way the owner likes.
- **Shape.** The secret is `ppa_inv_` plus 43 base64url characters (256 random bits). The link is
  `<site URL>/invite#<secret>`. Because the secret sits in the URL fragment, browsers never send it to the
  server or a proxy, so it stays out of access logs and `Referer` headers. The page reads it and posts it.
- **Storage.** `app_invite` stores only the SHA-256 and a hint, looked up by a unique index, like integration
  tokens (ADR-0013). It also records the label, the bound player ID, who minted it, when, the expiry, and the user who
  accepted it. A link queued for Discord exists in plain text only in Genie's pull response (§7).
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
  a link to copy uses the browser's own origin, and Settings says the link only works where that address does (often
  only on the LAN). **Send by Discord** needs the site URL, since a LAN address is no use to someone at home: 409
  `site_url_not_set` without it.
- **Logging.** Invite secrets and links are never logged or shown again after minting. `inviteUrl`, `inviteSecret`
  and `link` join the redacted log keys.

### 7. Messages to Discord through Genie

Attendance can send a message to a person it knows only by player ID. Genie finds their Discord account in its own
directory and sends the message to them as a direct message. Attendance never learns Discord IDs, and Genie needs no
new command for each kind of message.

- **The outbox.** A new `messaging` module owns `outbound_message`:
  - `league_id`, `player_id` (text), `kind`, `text` (plain, ≤ 1,800 characters, so it fits a Discord message);
  - an optional link (`link_label`, and `link_ciphertext`: the URL, sealed under AAD `outbound_message:<id>`,
    because an invite link is a secret). It uses a **message vault** with its own key (`NUXT_MESSAGE_VAULT_KEY`, or
    `/data/secrets/message-vault.key` generated once, mode 0600), built in `server/bootstrap/vaults.ts` and injected
    into `messaging` only. Like the TDF vault (ADR-0012), it never shares the refresh-token key;
  - `created_by`, `created_at`, `expires_at`;
  - `status` (`pending`, `delivered`, `no_discord_user`, `dm_refused`, `undeliverable`, `expired`, `cancelled`),
    `status_reason`, `attempts`, `next_attempt_at`, `delivered_at`;
  - `invite_id`, for an invite or reset message. Revoking or using the invite cancels the message if it is still
    pending, and deletes its link at once, so a dead link is never sent.

  Other modules queue a message through `MessagingService.queue({ playerId, kind, text, link?, expiresAt })`, and never
  read the table.
- **Kinds today:** `invite`, `password_reset`, `lease_granted`, `lease_ended`. A new kind is a new text template in
  attendance. Genie treats every kind the same way, so it needs no change for one. It may use `kind` for its own logs
  and settings.
- **Who gets messages.** Only professors and invitees: the player ID bound to an invite, or a professor's own
  connection. No route takes message text. The only way to address an arbitrary player ID is the owner's bound
  invite, and only with the invite template, after the confirm in §6 that names who the ID belongs to. So the outbox
  can't be used to send players, who include minors, anything but an invite the owner chose to send. Text is written by attendance from fixed templates. Names and labels inside it are
  plain text, with Discord mentions (`@…`, `<@…>`) removed.
- **When there is no Genie.** Genie counts as set up when a token with `messages:deliver` has pulled in the last 24
  hours. Otherwise **Send by Discord** isn't offered, and lease notices aren't queued.
- **Genie's routes** (bearer-only, scope `messages:deliver`):
  - `GET /api/integrations/v1/messages?limit=` (1–50, default 20) → `{ messages: [{ id, playerId, kind, text, link:
    { label, url } | null, createdAt, expiresAt }] }`: pending, unexpired messages whose `next_attempt_at` has
    passed, oldest first. A message stays
    pending until Genie reports on it, so a lost response is fetched again, with the same link. 120 per 15 minutes
    per token.
  - `POST /api/integrations/v1/messages/{id}/result { status, reason? }` → 204. `status` is `delivered`,
    `no_discord_user` (Genie has no Discord account for that player ID), `dm_refused` (the user doesn't accept direct
    messages from the bot) or `failed`. The first three are final. `failed` leaves it pending but holds it back:
    `next_attempt_at` is 1 minute later, doubling each time up to 1 hour. After 5 failures it becomes
    `undeliverable`, so a short Discord outage doesn't use up the retries. Reporting on a message that is already final is a no-op 204.
- **Delivery is at least once.** Genie skips a message ID it already sent, sends with mentions disabled, and never
  posts or logs the link.
- **Clean-up.** A final or expired message has its link ciphertext deleted at once. Rows are deleted 30 days after
  they were created, because the text can hold names.
- **What senders see.** The invite row and the lease show the message's status: "Sent by Discord", "No Discord
  account linked for <player ID>", "Doesn't accept direct messages", or "Not delivered".
- **Scopes (amends ADR-0013).** Integration tokens carry scopes chosen when they are minted: `integrations:read` (the
  day route) and `messages:deliver`. Existing tokens keep `integrations:read` only. Each route checks its own scope; a
  token that lacks it gets 403 `insufficient_scope`, with
  `WWW-Authenticate: Bearer realm="integrations", error="insufficient_scope"`. The route family is still bearer-only,
  and a token still counts nowhere else.
- **Genie's side** is a companion decision for Genie's own ADR: poll the outbox (every 30 s, say), look up each player
  ID in its directory, send the direct message, report the result.

### 8. Managing professors (owner)

- Settings → **Professors** lists every professor:
  - username, connection ("Display name (player id)"), membership state, connection status, last sign-in;
  - outstanding invites (label, bound player ID, minted by, expires, Discord delivery status), with **Revoke**;
  - **Invite professor**, and **Reset password** on each professor. Each shows the link once, with a copy button, or
    sends it by Discord to the invitee's player ID or the professor's own (§7);
  - every live lease, by organizer and lent professor;
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
  - **Proof after a reset.** A reset link can travel through Discord, so accepting it isn't enough to act as the
    professor. It sets `app_user.reverify_required_at`, and until that professor completes a Pokémon connect for
    their own connection's player ID, the account is in the waiting room (§3): only the routes listed there, and
    403 `reverify_required` everywhere else. Their connection keeps its token and keep-alive, but `actingConnection`
    refuses it for them, and leases they hold can't be used. A reset link is then worth no more than an invite.

### 9. Data and upgrade

- Forward-only migration:
  - `app_user.role` (existing account → `owner`) and `removed_at`;
  - `pokemon_connection.user_id` (every existing connection → the owner);
  - `league_membership`: the connection bound in `league_upstream` is seeded `member`, with `can_submit` from
    `activity_group_can_submit` and `checked_at` null. Every other connection is seeded `unknown`. The first
    keep-alive after boot checks every row whose `checked_at` is null;
  - `league_upstream` rebuilt without `connection_id`;
  - `app_invite` (with `for_user_id` for reset links and `for_player_id` for a bound invite);
  - `app_user.reverify_required_at` (§8);
  - `tournament_lease` (§5);
  - `outbound_message` (§7);
  - `submission.lease_id`, set on a staff or results job started under a lease;
  - `pokemon_connection.claimed_from_user_id` and `claimed_at`;
  - `integration_token.scopes` (`integrations:read`, `messages:deliver`), existing rows → `integrations:read`.
- **After the upgrade, the owner can do what they could before.** They hold every connection, and the connection that
  submitted before is a `member` that can submit, so Submit works at once. One difference: Submit asks which of their
  connections to submit as once more than one is a `member` that can submit.
- **Module ownership:**
  - `accounts` owns `app_user` and `app_invite`, and exports the `Actor` type and the invite service.
  - `pokemon` owns `user_id`, `league_membership`, `tournament_lease` and `actingConnection`.
  - The new `messaging` module owns `outbound_message`. `accounts` and `pokemon` queue through its service, and the
    `integrations` module serves Genie's routes through it.
  - `submission`, `staffing` and `tournaments` take an `actor` and never read these modules' tables.
- **Rollback:** as ADR-0008. Stop the container, restore the pre-upgrade backup, and pin the previous image.

## Consequences

- (+) Each professor signs in as themselves, and nobody needs anyone else's Pokémon password.
- (+) The play-tools records each professor adds are under their own account, and History shows who.
- (+) Professors see the whole league's schedule, so they can split cups and challenges, while each tournament stays
  in its organizer's hands.
- (+) A leaked invite or reset link exposes nothing before its holder completes a Pokémon login: for an invite, to an
  account in this league (the bound one, when set); for a reset, to the professor's own account.
- (+) Undo and retry run as the professor who made the submission.
- (+) An organizer who can't be at an event can lend it, and the lent professor staffs it and uploads its results
  without ever holding the organizer's Pokémon login.
- (+) Any later feature can message a professor on Discord by adding a text template. Genie doesn't change.
- (−) CLAUDE.md's key points and module rules must change with the implementation. They still say the league names
  the submitting professor, and that the league must be shared by every professor. They also say
  `/api/integrations/v1/*` is the only exception to the session rule, and the public `/api/invites/*` routes are a
  second one.
- (−) The owner loses the ability to act for a professor whose account moves to that professor's own login. That is
  intended, but the owner can no longer cover for an absent professor's tournaments.
- (−) An invite travels through Discord, which is a third party. The link's single use, its 72-hour life, the bound
  player ID and the membership gate limit what a copy is worth.
- (−) Upstream, a lent professor's staff and results changes are the organizer's: play-tools records them under the
  organizer's account. Only History here says who really made them.
- (−) Messages wait for Genie's next poll, so an invite can take up to the poll interval to arrive.
- (−) A third vault key (`message-vault.key`) joins the secrets to back up with `/data`. Losing it only loses
  undelivered links, which the owner mints again.
- (−) Every write path gains an authorization check, and every route an access test. The test matrix grows to
  four kinds of caller per route: owner, member professor, lent professor and outside professor.
- (−) Membership is up to 24 hours stale. A professor dropped from the league upstream keeps seeing the league for up
  to a day, but they still can't write to play-tools for it: upstream refuses them.
- (−) Each professor is one more keep-alive refresh an hour, within the existing cap of 10 connections.
