# ADR-0016: Calendar feeds: subscribable iCalendar URLs for the league's tournaments and play sessions

- Status: Proposed (2026-10-20, #205)
- Date: 2026-10-20
- Issue: [#205](https://github.com/Towerism/play-pokemon-attendance-web/issues/205)
- Amends:
  - architecture §7, §9 and the CLAUDE.md route rule: a third route family outside the session cookie,
    `GET /api/calendar/v1/feed.ics`, which takes only a calendar feed secret in its query string. The PR that builds
    the route updates CLAUDE.md.
  - [ADR-0013](0013-read-only-integrations-api.md): its "a token counts nowhere else" stays true; a calendar secret is a
    different kind of token and counts only on the feed route.
- Builds on: [ADR-0010](0010-tournament-templates-and-lifecycle.md) (planned tournaments and the Upcoming read),
  [ADR-0015](0015-professor-logins.md) (owner and professor roles, league membership, leases, reads across
  professors).

## Decision in brief

The app serves read-only iCalendar feeds (RFC 5545, the standard calendar file format) that Google Calendar, Apple
Calendar and Outlook subscribe to. Nothing is written to anyone's calendar, and no calendar provider is signed in to.

- **One public feed per league**, turned on by the owner: the league's tournaments that exist in play-tools, and
  its play sessions. No staff, no player IDs, no contact details. Anyone with the link can subscribe.
- **One feed per user**, turned on by each owner or professor for themselves: the tournaments they organize, are
  staff on, or hold a lease on, planned ones included as tentative.
- The secret is in the URL (`…/feed.ics?token=ppa_cal_…`), stored only as a SHA-256, and can be rotated.
- A feed request never calls play-tools. It is served from a stored snapshot, which an hourly task and the app's own
  tournament changes keep current. An event leaves the public feed only when the app knows it is off: a failed read,
  a disconnected professor or a lagging listing never removes one.
- Calendar services that fetch from their own servers (Google Calendar, iCloud, Outlook.com) need the feed reachable
  from the internet over HTTPS. The deploy guide gains a reverse-proxy recipe that exposes only the feed route.

## Context

The organizer asked for calendar integration (#205, scoped 2026-10-20):

- **Direction:** subscribe only. The app serves a feed URL; it never signs in to a calendar provider.
- **Contents:** tournaments, planned and created, and league play sessions.
- **Feeds:** a public feed for players, shareable with no login, and a feed per professor.

Facts this design rests on:

- **Tournaments have a start but no end.** play-tools stores `start_date_v2`, and templates store a start time
  (`tournament_template.start_time`), never a length.
- **Play sessions live only in play-tools.** The app reads them by date range (`PlayToolsGateway.listPlaySessions`,
  §4.4), which stops at the first status that returns a match. They have a start, an optional end and no title.
- **Planned tournaments are local rows** (`planned_tournament`), materialised from schedules on every Upcoming read.
  A created row keeps its id and links to the upstream GUID (`tournament_id`, unique per league). A row can also
  adopt a tournament made by hand in play-tools (ADR-0010 decision 5).
- **play-tools' tournament listing leaves out cancelled tournaments.** A tournament that stops appearing in a
  successful listing of its organizer has been cancelled, deleted or moved.
- **The fields Upcoming carries** are the name, start, game, format, display id, state and organizer. Registration,
  the event website and the venue are on the template or planned row, or else only in play-tools' per-tournament
  details read.
- **Calendar clients poll on their own schedule, and many poll from their own servers.** Google Calendar fetches
  from Google's servers every few hours to a day. Calendars stored in iCloud are fetched by Apple's servers, and
  Outlook.com and the new Outlook for Windows by Microsoft's. Only device-local subscriptions (macOS "On My Mac",
  classic Outlook desktop) fetch from the device. No client sends an `Authorization` header, so the secret has to be
  in the URL.
- **The app is normally only on the LAN** (ADR-0006, §9). Remote access is through an HTTPS reverse proxy or
  Tailscale, and a provider's servers can reach neither the LAN nor a tailnet.
- **`NUXT_PUBLIC_SITE_URL` already decides other things:** invite and lease links, the cookie `Secure` flag and HSTS.
  It can't point at a host that serves only the feed.
- **The kit's request log writes one line per request with its path, never the query string** (`requestLogPlugin`,
  `server/plugins/logging.ts`).

What makes a feed dangerous is a **false cancellation**. When an event leaves a subscribed feed, the calendar client
deletes it, and players who relied on it stay home. A lapsed Pokémon login, a professor disconnecting, or a listing
that lags must never do that. ADR-0013 guards against the same failure for Genie.

## Options considered

1. **Serve iCalendar feeds from the app, behind secret URLs (chosen).** Every calendar app supports subscribing
   to a URL, and the app needs no account with anyone.
2. **Push events into a Google Calendar** through OAuth. It updates within seconds, but it ties the league to one
   provider, needs a Google Cloud project and a stored Google refresh token, and players would still subscribe to
   that calendar by its link. Rejected at scoping.
3. **A static `.ics` file the organizer exports and uploads somewhere.** Nothing to expose, but it goes stale the
   day it is exported.
4. **Feeds at fixed public URLs with no secret.** Simplest to share, but the professor feeds would need some other
   gate, and nobody could revoke a link that leaked to the wrong place.

For the URL secret, a path segment (`/feeds/ppa_cal_….ics`) was weighed against the query string. A path segment
would land in the app's own request log; the query string never does.

For freshness, reading play-tools on every request was rejected: a public URL would let anyone on the internet
trigger play-tools traffic as the league's professors. Refreshing only when a feed is fetched was also rejected: with
Google fetching once or twice a day, each fetch would be answered from the snapshot built at the previous one, a day
or more old.

## Decision

### 1. Feeds and their secrets

The `calendar` module (`server/modules/calendar`, new) owns `calendar_feed`:

| Column | Meaning |
| --- | --- |
| `id` | integer key |
| `league_id` | the league |
| `kind` | `public` or `user` |
| `user_id` | the user a `user` feed belongs to; null for `public` |
| `token_sha256` | SHA-256 of the secret, unique |
| `hint` | `ppa_cal_…` plus the secret's last 4 characters |
| `created_at`, `last_read_at` | `last_read_at` is written at most once a minute |

- A secret is `ppa_cal_` plus 43 base64url characters (256 random bits), shown once, like an integration token
  (ADR-0013 decision 2). Lookup is by digest through the unique index.
- A league has at most one `public` feed and each user at most one `user` feed. **Rotate** replaces the secret in
  the same row, so the old link stops working on its next fetch. **Turn off** deletes the row.
- Only the owner rotates or turns off the public feed. Each user does the same for their own feed only, and the
  owner can't see or mint a professor's.
- Removing a professor (ADR-0015 §6) deletes their feed.
- **Feed links** start with the first of these that is set:
  1. `NUXT_CALENDAR_BASE_URL` (optional, *Advanced* in the Unraid template): the internet-facing HTTPS address the
     proxy recipe in section 7 serves the feed on. It changes nothing but feed links.
  2. `NUXT_PUBLIC_SITE_URL`.
  3. The origin of the Settings request that showed the link.

  With the third, Settings says the link works only where that address does, which on a LAN install means
  device-local subscriptions on the LAN.
- The secret travels in the query string so the app's request log never holds it. A reverse proxy's access log may;
  the deploy guide says so (section 7).

### 2. What each feed holds

Both feeds cover from 30 days before today to 26 weeks after it, in the league `TZ`. That is Upcoming's default
range (`GET /tournaments/upcoming`) widened backwards, so last month's events stay on people's calendars.

| | Public feed | User feed |
| --- | --- | --- |
| Name (`X-WR-CALNAME`) | "<league name>" | "<league name>: my tournaments" |
| Tournaments created in play-tools, in the league | every one | those the user organizes (any of their connections), is staff on, or holds a lease on |
| Planned tournaments not created yet | none (open question Q1) | those whose template's organizer is one of the user's connections, as `STATUS:TENTATIVE` |
| Skipped planned tournaments | none | none |
| Play sessions | every one in the league | none (open question Q3) |
| Staff, player IDs, contact email and phone | never | never |

- **"Staff on"** means the user's player ID is in the tournament's live staff assignments made in the app
  (`staff_assignment`, the same desired state the Staff card and Genie read, ADR-0013 decision 5). This is narrower
  than the organizer's "are staff on": a professor added as staff only in play-tools is left out. Including them
  costs one or two participant reads per tournament on every refresh, so it is open question Q5.
- **A tournament play-tools hasn't sanctioned** (its sanctioning state is anything but `sanctioned`, such as
  `approval-pending` or `sanctioning-error`) is `STATUS:TENTATIVE` in both feeds.
- **The user feed marks the user's part** in each event: "You organize", "Staff: Judge" or "Lent to you until
  <date>". A tournament can carry more than one.
- **An event is built only from fields a refresh already reads**, with no per-tournament details call:
  - `SUMMARY`: the tournament's name with tokens filled, or the play session's label ("Open play · TCG, VG", §4.4).
  - `DTSTART`: the start as a UTC instant.
  - `DTEND`: the session's end; for a tournament or a session with no end, the start plus a default length (open
    question Q2: how long an event lasts).
  - `LOCATION`: the venue label of the tournament's template or planned row. A tournament no row holds has none.
  - `DESCRIPTION`: game and format and the play-tools display id. For a tournament a row holds, also its
    registration details and event website from the template and the row's overrides.
  - `URL`: that event website, when there is one.
- A planned tournament whose start a DST change skips or repeats (Upcoming's `timeProblem`) is left out until it is
  fixed.

### 3. Stable identities, updates and cancellations

- **`UID`s never change for the life of an event.** The snapshot stores the `UID` it issued for each event and keeps
  it:
  - an event first seen as a planned row is `planned-<row id>@<league id>.play-pokemon-attendance`, before and after
    it is created;
  - an event first seen as a play-tools tournament is `tournament-<GUID>@…`, and keeps that `UID` if a planned row
    later adopts it;
  - a play session is `session-<GUID>@…`.

  Creating, rescheduling or adopting a tournament updates the event in place.
- **Changes show through `LAST-MODIFIED`**: the time the event's rendered content last changed. A subscribed feed
  (`METHOD:PUBLISH`) is replaced by `UID` on every fetch, so no `SEQUENCE` is sent. `SEQUENCE` belongs to
  invitations, which the feeds never are.
- **A cancellation is shown, never only dropped.** When the app knows an event is off, the event stays in the feed
  with `STATUS:CANCELLED` and "Cancelled: " before its name, until 7 days after its start. The app knows when:
  - a planned row's state becomes `cancelled` (ADR-0010 Cancel), or a row in the user feed becomes `skipped`;
  - a tournament in the last snapshot, whose last known start lies inside the range just read, is missing from a
    **successful** listing of its organizer;
  - a play session in the last snapshot, whose last known start lies inside the range just read, is missing from a
    successful listing of every status (section 5).
- **In the public feed, a tournament leaves only by cancellation or by its date passing.** If its organizer's source
  disappears (they disconnected, were removed, or their connection reads as `outside` while a listing lags,
  ADR-0015 §3 and §6), its events are kept unchanged and marked "(not confirmed since <date>)". They stay until 7 days after
  their start, or until a successful read of that organizer lists or cancels them.
- **In a user feed, an event drops out when it stops being the user's**: a lease ended, a staff assignment was
  removed, or their connection was disconnected. The tournament isn't off; it's no longer theirs to see.

### 4. The feed route

`GET /api/calendar/v1/feed.ics?token=<secret>`, in `server/api/calendar/v1/feed.ics.ts`, which accepts `GET` and
`HEAD` only. `HEAD` answers like `GET` without the body. Any other method is the catch-all's JSON 404 (§7).

- It takes **only** the secret in `token`, through one guard, `requireCalendarFeed(event)` in
  `server/utils/calendar.ts`, which `test/unit/route-guards.test.ts` holds the route to. A session cookie, an
  integration token or an `Authorization` header grants nothing here, and a calendar secret grants nothing anywhere
  else.
- **A permanent refusal is `404` with an empty body**, the same for every reason, so a guess learns nothing. Calendar
  clients treat a 404 as "this subscription is gone". The reasons are: a missing, malformed, unknown or rotated
  secret, a feed that was turned off, a removed user, and a user whose connection is `outside` the league.
- **A temporary refusal is `503` with `Retry-After: 3600` and an empty body**, so the client keeps the subscription
  and its events. It answers a user feed whose connection's membership is `unknown` (it resets on every reconnect,
  ADR-0015 §3) and a league with no activity group selected.
- `200` with `Content-Type: text/calendar; charset=utf-8`, `Cache-Control: private, max-age=300`, a strong `ETag`
  of the body and `X-Robots-Tag: noindex`. `If-None-Match` with the current `ETag` gets `304`.
- **Two limiters**, built at boot by `server/bootstrap/rate-limits.ts`, each with its own variables:
  - fetches: 30 per 15 minutes per client and secret together (`NUXT_CALENDAR_FETCH_RATE_LIMIT_*`), so one
    subscriber or one script can't use up a shared public link for anyone else;
  - refusals: 60 refused fetches per 15 minutes per client (`NUXT_CALENDAR_REFUSAL_RATE_LIMIT_*`). It counts only
    refusals and is checked only for a secret that doesn't match, so it never blocks a valid secret.

  Over either: 429 with `Retry-After`. The client is the TCP peer, or the proxy's appended `X-Forwarded-For` entry
  from a trusted proxy (§9). A feed fetch is a snapshot read and a serialisation, with no play-tools call, so these
  limits protect the app, not play-tools.
- Each successful fetch logs one `calendar feed read` line: feed id and kind, event count, and the snapshot's age.
  Never the secret.

### 5. The snapshot, and no false cancellations

A feed request never calls play-tools. It reads the league's snapshot, filters it for the feed, and serialises it.

- **`calendar_snapshot`**, owned by the `calendar` module, holds one row per league:
  - when it was built;
  - each event's normalised fields, its `UID`, a hash of its rendered content and `LAST-MODIFIED`, and its
    cancelled or unconfirmed mark;
  - the **source** each event came from: one per connected professor (their tournaments) and one for play
    sessions, each with the time of its last successful read.
- **User feeds are filtered at serve time** from the league's events, with three local reads through exported
  services (modules never read each other's tables):
  - `StaffingService.liveAssignmentsFor(playerIds, range)` (new): the tournaments those player IDs are assigned to;
  - the pokemon module's `LeaseService.liveLeasesFor(userId)` (new): the tournaments lent to the user;
  - the pokemon module's connection service: the user's connections and their player IDs.

  The user's part ("You organize", "Staff: Judge", "Lent to you until …") is added then, and a user feed's
  `LAST-MODIFIED` for an event is the later of the event's and the user's last change to that part.
- **When it is refreshed:**
  - by the existing hourly task (`nuxt.config.ts` `scheduledTasks`, a new `calendar:refresh`), only for a league
    with a feed fetched in the last 48 hours. A league nobody subscribes to causes no play-tools traffic;
  - by the app's own changes. When a tournament job ends, or a planned row is created, skipped, moved or cancelled,
    the `tournaments` module calls an injected `onTournamentsChanged` callback (wired in `server/plugins`), and the
    `calendar` module rebuilds the snapshot's local part (planned rows and their states) at once, with no play-tools
    call;
  - when a feed is turned on or rotated, before the link is answered, so a new feed is never empty.

  At most one refresh runs per league.
- **What a refresh reads:**
  - the tournaments: the same reads as an Upcoming load with `refresh=1` (every connection that isn't `outside`,
    one at a time, each as itself; ADR-0015 §3), through `TournamentsService.upcoming`;
  - the play sessions in the range, read as one `member` connection (lowest id first, ADR-0015 §4 "Attendance
    reads"), through a new `listPlaySessionsInRange` that the `submission` module exports. It lists `active`, `pending`
    and `complete` with a call each and merges them, because the gateway call stops at the first status with a
    match. The source counts as read only when all three calls succeed.
- **A source whose read fails** (`needs_reconnect`, `upstream_unavailable`, `refused`) keeps its events from the
  previous snapshot unchanged and never produces a cancellation. The same holds for a connected professor Upcoming
  reports with no player ID: their events can't be matched to a source, so every source's events are kept until the
  professor is identified.
- **A source that disappears** keeps its events in the public feed (section 3).
- **After 14 days without a successful read**, a source's events are kept but marked "(not confirmed since <date>)",
  and Settings shows the source as stale.
- Refresh failures are logged with the source and the error code, as Upcoming's are.

### 6. Settings

Settings gains a **Calendar** panel.

- **The owner** sees the public feed: off, or on with its hint, and **Turn on**, **Rotate link** and **Turn off**.
- **Every user** sees their own feed, with the same three actions.
- A new link is shown once, with a copy button and a `webcal://` link, and says where it works:
  - with an internet-facing link (`NUXT_CALENDAR_BASE_URL` or an `https://` *Site URL*): Google Calendar
    (**From URL**), iCloud, Outlook.com and devices;
  - otherwise: only device-local subscriptions (macOS "On My Mac", classic Outlook desktop) on a network that
    reaches the app.
- The panel shows the snapshot's age and any stale source.

Routes, each with one access guard (`test/unit/route-guards.test.ts`):

| Route | Guard | Purpose |
| --- | --- | --- |
| `GET /calendar-feeds` | `requireMember` | the caller's own feed and, for the owner, the public feed: hint, created, last read; snapshot age and stale sources |
| `POST /calendar-feeds/me` | `requireMember` | turn on or rotate the caller's feed; answers the new link once |
| `DELETE /calendar-feeds/me` | `requireMember` | turn off the caller's feed |
| `POST /calendar-feeds/public` | `requireOwner` | turn on or rotate the public feed; answers the new link once |
| `DELETE /calendar-feeds/public` | `requireOwner` | turn off the public feed |

### 7. Reaching the feed from outside

- `docs/deploy/unraid.md` gains a **Calendar feeds** section. Its reverse-proxy recipe (SWAG, Nginx Proxy Manager,
  Caddy) serves an HTTPS host that forwards only `= /api/calendar/v1/feed.ics`, for `GET` and `HEAD`, and answers
  everything else with 404. The guide sets `NUXT_CALENDAR_BASE_URL` to that host and leaves *Site URL* as it was.
- An organizer whose app already sits behind an HTTPS proxy at *Site URL* can instead open that one path on the
  existing host. Then `NUXT_CALENDAR_BASE_URL` stays empty.
- The recipe sets `NUXT_TRUSTED_PROXIES` to the proxy's address, so each internet client gets its own rate limits.
- It checks through the proxy that `/`, `/api/setup`, `/api/auth/session` and an encoded `..` path answer 404.
- It warns that a proxy's access log may record the full URL, secret included, and shows how to leave the query
  string out of it.
- Nothing becomes required in the Unraid template (ADR-0006). The feature is off until a feed is turned on.

### 8. Serialising iCalendar

A small, pure writer in `server/modules/calendar/ical.ts`, with no dependency: `VCALENDAR` with `VERSION:2.0`,
`PRODID`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-CALNAME`, `X-WR-TIMEZONE` (the league `TZ`), and
`REFRESH-INTERVAL;VALUE=DURATION:PT1H` with `X-PUBLISHED-TTL:PT1H` so clients that honour them poll hourly. One
`VEVENT` per event with `UID`, `DTSTAMP` (the snapshot time), `LAST-MODIFIED` and `STATUS`. Times are UTC (`…Z`), so
no `VTIMEZONE` is needed. Text is escaped (`\\`, `;`, `,`, newlines), lines are folded at 75 octets without splitting
a UTF-8 character, and every line ends in CRLF. A library (`ical-generator`) was weighed; the format the feeds need is
small enough that a tested writer is less to keep up to date than a dependency.

## Consequences

- (+) Players and professors get the league's events in the calendar app they already use, with nothing to install.
- (+) Nothing but a known cancellation or the passing of its date removes an event from the public feed. A lapsed
  login, a disconnect or a lagging listing leaves it, marked unconfirmed at worst.
- (+) Feed traffic can't reach play-tools: refreshes are hourly, only while someone subscribes, with Upcoming's read
  cost plus three play-session listings.
- (+) Every feed can be cut off at once by rotating or turning it off.
- (−) A leaked public link lets anyone see the league's tournament and session times and venue names. Those are
  public on the Pokémon event locator anyway.
- (−) A leaked user feed shows which tournaments that professor organizes or staffs. Rotating fixes it.
- (−) Calendars lag: Google may take up to a day to fetch, and a change made only in play-tools reaches the snapshot
  within an hour. A last-minute cancellation still needs a Discord message.
- (−) Sharing through Google, iCloud or Outlook.com needs a reverse proxy open to the internet, the first route of
  this app that faces the internet by design. The recipe exposes only the feed route, which is read-only and
  rate-limited.
- (−) Event lengths are a guess (open question Q2), because play-tools has no end time for tournaments.
- (−) A tournament the app didn't plan has no location or registration details in the feed, because those come only
  from play-tools' per-tournament details read, which the refresh skips.
- (−) A third route family outside the session cookie. It is one route behind one guard, held to it by the
  route-guard test and by an auth matrix in its server tests.

## Open questions

| | Question | Designed as |
| --- | --- | --- |
| Q1 | Should the public feed show planned tournaments that aren't created in play-tools yet? A planned tournament may never be sanctioned. | **Open: organizer.** No: only created tournaments. Planned ones are in user feeds, as tentative |
| Q2 | How long is an event when play-tools gives no end? | **Open: organizer.** 4 hours for a tournament; a play session's own end, else 3 hours |
| Q3 | Should a user feed include the league's play sessions too? | **Open: organizer.** No: a professor who wants them also subscribes to the public feed |
| Q4 | Is 30 days back and 26 weeks ahead the right range? | **Open: organizer.** Yes |
| Q5 | Should "staff on" include staff added only in play-tools, not in the app? It costs one or two participant reads per tournament on every hourly refresh. | **Open: organizer.** No: only staff assigned in the app, as Genie reads them |

## Tests these decisions need

- **Pure:**
  - the iCalendar writer: escaping, folding at 75 octets across multi-byte characters, CRLF, UTC times, the refresh
    hints, and a fixture checked once against an RFC 5545 validator;
  - the event projection: summary, description, location, default lengths, tentative for planned and unsanctioned
    tournaments, the user's part;
  - `UID` stability across create, reschedule and adoption after first publication;
  - the cancellation rules: a failed source, a source that disappears and a professor with no player ID never
    cancel; an event moved outside the range is not cancelled; a play-session listing with an active session
    alongside pending ones.
- **Module (real SQLite):** mint, rotate, turn off, one feed per kind, lookup by digest, a removed professor's feed
  deleted; snapshot carry-forward per source, the unconfirmed mark and the 14-day stale mark; single-flight refresh;
  the local rebuild on a tournament change; the hourly task skipping leagues with no recent fetch.
- **Server, over HTTP, with the fake play-tools:**
  - the auth matrix: no secret, malformed, unknown, rotated, turned off, a session cookie, an integration token,
    an `outside` professor's feed, all the same 404; an `unknown` membership and no selected league, 503;
  - public and user feed contents for owner, professor, lent professor and staff, and nothing personal in the
    public feed;
  - `ETag` and `304`, `HEAD`, other methods;
  - the limiters: many clients fetching the public feed are none of them refused, one client over its budget is,
    and refusals never block a valid secret;
  - no play-tools call on a fetch; a professor's failed read keeps their events;
  - the secret never in a log line or a response other than the mint.
- **E2E:** turning a feed on shows the link once, then only its hint after a reload; rotating changes the link; a
  professor sees no public-feed controls.
