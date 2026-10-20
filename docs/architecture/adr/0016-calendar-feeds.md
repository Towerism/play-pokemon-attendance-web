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

The app serves read-only iCalendar feeds (RFC 5545, the standard calendar file format) that Google Calendar, Apple Calendar and Outlook subscribe to.
Nothing is written to anyone's calendar, and no calendar provider is signed in to.

- **One public feed per league**, minted by the owner: the league's tournaments that exist in play-tools, and its
  play sessions. No staff, no player IDs, no contact details. Anyone with the link can subscribe.
- **One feed per user**, minted by each owner or professor for themselves: the tournaments they organize, are staff
  on, or hold a lease on, planned ones included as tentative.
- The secret is in the URL (`…/feed.ics?token=ppa_cal_…`), stored only as a SHA-256, and can be rotated.
- A feed request never calls play-tools. It is served from a stored snapshot, refreshed in the background at most
  every 30 minutes per league, and a professor whose read fails keeps their last known events.
- Subscribing from Google Calendar needs the feed route reachable from the internet over HTTPS. The deploy guide
  gains a reverse-proxy recipe that exposes only that path.

## Context

The organizer asked for calendar integration (#205, scoped 2026-10-20):

- **Direction:** subscribe only. The app serves a feed URL; it never signs in to a calendar provider.
- **Contents:** tournaments, planned and created, and league play sessions.
- **Feeds:** a public feed for players, shareable with no login, and a feed per professor.

Facts this design rests on:

- **Tournaments have a start but no end.** play-tools stores `start_date_v2`, and templates store a start time
  (`tournament_template.start_time`), never a length.
- **Play sessions live only in play-tools.** The app reads them by date range (`PlayToolsGateway.listPlaySessions`,
  §4.4). They have a start, an optional end and no title.
- **Planned tournaments are local rows** (`planned_tournament`), materialised from schedules on every Upcoming read.
  A created row keeps its id and links to the upstream GUID (`tournament_id`, unique per league).
- **play-tools' tournament listing leaves out cancelled tournaments.** A tournament that stops appearing in a
  successful listing has been cancelled or deleted.
- **Calendar clients poll on their own schedule.** Google Calendar fetches from Google's servers, every few hours
  to a day, and can't be told to come back sooner. Apple Calendar and Outlook desktop fetch from the device. None
  of them can send an `Authorization` header, so the secret has to be in the URL.
- **The app is normally only on the LAN** (ADR-0006, §9). Remote access is through an HTTPS reverse proxy or
  Tailscale, and Google's servers can reach neither the LAN nor a tailnet.
- **The kit's request log writes one line per request with its path, never the query string** (`requestLogPlugin`,
  `server/plugins/logging.ts`).

What makes a feed dangerous is a **false cancellation**: if a professor's Pokémon login lapses and the feed then
leaves out their tournaments, every subscribed calendar deletes those events, and players stay home. This is the
same failure ADR-0013 guards against for Genie.

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
trigger play-tools traffic as the league's professors. A scheduled refresh every 30 minutes was also rejected,
because it reads play-tools all day even when nobody subscribes.

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
- Removing a professor (ADR-0015 §6) deletes their feed. While a professor's connection isn't `member` of the
  league, their feed answers as an unknown secret (section 4) and is kept, so it works again once they are back.
- Feed links are built from `NUXT_PUBLIC_SITE_URL`, as invite links are (ADR-0015 §6). Without it, Settings shows
  the feed panel with 409 `site_url_not_set` and says why.
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

- **"Staff on"** means the user's player ID is in the tournament's live staff assignments (`staff_assignment`, the
  same desired state the Staff card and Genie read, ADR-0013 decision 5). Staff present only in play-tools are left
  out.
- **The user feed marks the user's part** in each event: "You organize", "Staff: Judge" or "Lent to you until
  <date>". A tournament can carry more than one.
- **An event is built from fields the app already has:**
  - `SUMMARY`: the tournament's name with tokens filled, or the play session's label ("Open play · TCG, VG", §4.4).
  - `DTSTART`: the start as a UTC instant.
  - `DTEND`: the session's end; for a tournament or a session with no end, the start plus a default length (open question Q2: how long an event lasts).
  - `LOCATION`: the venue label, when a template or planned row names one; otherwise nothing.
  - `DESCRIPTION`: game and format, the play-tools display id, registration details and the event website, when
    known.
  - `URL`: the event website, when there is one.
- A planned tournament whose start a DST change skips or repeats (Upcoming's `timeProblem`) is left out until it is
  fixed.

### 3. Stable identities, updates and cancellations

- **`UID`s never change for the life of an event.** A tournament that has a planned row is
  `planned-<row id>@<league id>.play-pokemon-attendance`, before and after it is created. A tournament no row
  holds is `tournament-<GUID>@…`, and a play session is `session-<GUID>@…`. Creating a planned tournament, or
  rescheduling a created one, updates the event in place.
- **Changes are visible by `LAST-MODIFIED` and `SEQUENCE`.** The snapshot keeps each event's content hash, and
  `SEQUENCE` goes up by one whenever that hash changes.
- **A cancellation is shown, never only dropped.** When the app knows an event is off, the event stays in the feed
  with `STATUS:CANCELLED` and "Cancelled: " before its name, until 7 days after its start. The app knows when:
  - a planned row's state becomes `cancelled` (ADR-0010 Cancel), or a row in the user feed becomes `skipped`;
  - a tournament in the last snapshot is missing from a **successful** listing of its organizer;
  - a play session in the last snapshot is missing from a successful listing of its date range.
- An event that leaves a feed for another reason (its organizer disconnected, a lease ended, a staff assignment was
  removed) drops out. Its organizer still runs it; it is no longer this user's.

### 4. The feed route

`GET /api/calendar/v1/feed.ics?token=<secret>`, in `server/api/calendar/v1/feed.ics.get.ts`.

- It takes **only** the secret in `token`. A session cookie, an integration token or an `Authorization` header
  grants nothing here, and a calendar secret grants nothing anywhere else.
- A missing, malformed, unknown or rotated secret, a user feed of a removed or non-member professor, and a league
  with no selected activity group all answer the same `404` with an empty body. Calendar clients treat a 404 as "this
  subscription is gone", and a guess learns nothing.
- `200` with `Content-Type: text/calendar; charset=utf-8`, `Cache-Control: private, max-age=300`, a strong `ETag`
  of the body and `X-Robots-Tag: noindex`. `If-None-Match` with the current `ETag` gets `304`.
- `HEAD` answers like `GET` without the body. Every other method is the catch-all's JSON 404 (§7).
- Each secret is limited to 60 fetches per 15 minutes, and each client to 60 refused fetches per 15 minutes
  (`NUXT_CALENDAR_RATE_LIMIT_*`, built at boot by `server/bootstrap/rate-limits.ts`): 429 with `Retry-After`.
- Each successful fetch logs one `calendar feed read` line: feed id and kind, event count, and the snapshot's age.
  Never the secret.

### 5. The snapshot, and no false cancellations

A feed request never calls play-tools. It reads the league's snapshot, filters it for the feed, and serialises it.

- **`calendar_snapshot`**, owned by the `calendar` module, holds one row per league:
  - when it was built;
  - each event's normalised fields, `UID`, content hash and `SEQUENCE`;
  - the **source** each event came from: one per connected professor (their tournaments) and one for play
    sessions, each with the time of its last successful read.

  User feeds filter this snapshot at serve time with the live staff assignments and leases, which are local reads,
  so one refresh serves every feed.
- **When it is refreshed.** A fetch that finds the snapshot older than 30 minutes starts one background refresh for
  the league and is answered from the old snapshot at once. At most one refresh runs per league. Minting or rotating
  a feed refreshes before it answers, so a new feed is never empty. Nothing refreshes while nobody fetches.
- **What a refresh reads:**
  - the tournaments: the same reads as an Upcoming load with `refresh=1` (every connection that isn't `outside`,
    one at a time, each as itself; ADR-0015 §3), through the `tournaments` module's exported service;
  - the play sessions in the range, every status, read as one `member` connection (lowest id first, ADR-0015 §4
    "Attendance reads"), through a range listing the `submission` module exports.
- **No false cancellations.** A source whose read fails (`needs_reconnect`, `upstream_unavailable`, `refused`) keeps
  its events from the previous snapshot unchanged, and never produces a cancellation. A professor who is
  disconnected drops their source, and their tournaments drop out (section 3). After 14 days without a successful
  read, a source's events are kept but marked "(not confirmed since <date>)" in their description, and Settings shows
  the source as stale.
- Refresh failures are logged with the source and the error code, as Upcoming's are.

### 6. Settings

Settings gains a **Calendar** panel.

- **The owner** sees the public feed: off, or on with its hint, and **Turn on**, **Rotate link** and **Turn off**.
- **Every user** sees their own feed, with the same three actions.
- A new link is shown once, with a copy button, a `webcal://` link for Apple Calendar and Outlook, and a short
  "Add to Google Calendar" note (Google needs the `https://` link, pasted into **From URL**).
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

- Apple Calendar and Outlook on a device that can reach the app (the LAN, or the tailnet) work with no change.
- Google Calendar, and any player at home, needs the feed over HTTPS from the internet. `docs/deploy/unraid.md`
  gains a **Calendar feeds** section with a reverse-proxy recipe (SWAG, Nginx Proxy Manager, Caddy) that forwards
  only `/api/calendar/v1/` to the app and answers everything else on that host with 404. *Site URL* is set to that
  host.
- The guide warns that a proxy's access log may record the full URL, secret included, and shows how to drop the
  query string from it.
- Nothing becomes required in the Unraid template (ADR-0006). The feature is off until the owner turns a feed on.

### 8. Serialising iCalendar

A small, pure writer in `server/modules/calendar/ical.ts`, with no dependency: `VCALENDAR` with `VERSION:2.0`,
`PRODID`, `CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-CALNAME` and `X-WR-TIMEZONE` (the league `TZ`); one `VEVENT`
per event with `DTSTAMP` (the snapshot time). Times are UTC (`…Z`), so no `VTIMEZONE` is needed. Text is escaped
(`\\`, `;`, `,`, newlines), lines are folded at 75 octets without splitting a UTF-8 character, and every line ends in
CRLF. A library (`ical-generator`) was weighed; the format the feeds need is small enough that a tested writer is
less to keep up to date than a dependency.

## Consequences

- (+) Players and professors get the league's events in the calendar app they already use, with nothing to install.
- (+) A lapsed Pokémon login never deletes events from anyone's calendar; it can only leave them unconfirmed.
- (+) Feed traffic can't reach play-tools: strangers hitting the public link cause at most one refresh per 30
  minutes, with Upcoming's own read cost.
- (+) Every feed can be cut off at once by rotating or turning it off.
- (−) A leaked public link lets anyone see the league's tournament and session times and venue names. Those are
  public on the Pokémon event locator anyway.
- (−) A leaked user feed shows which tournaments that professor organizes or staffs. Rotating fixes it.
- (−) Calendars lag: Google may take up to a day to show a change, and the snapshot adds up to 30 minutes. A
  last-minute cancellation still needs a Discord message.
- (−) Sharing through Google needs a reverse proxy open to the internet, which is the first route of this app that
  faces the internet by design. The recipe exposes only the feed path, which is read-only and rate-limited.
- (−) Event lengths are a guess (open question Q2), because play-tools has no end time for tournaments.
- (−) A third route family outside the session cookie. It is one route, held to its guard by the route-guard test and
  by an auth matrix in its server tests.

## Open questions

| | Question | Designed as |
| --- | --- | --- |
| Q1 | Should the public feed show planned tournaments that aren't created in play-tools yet? A planned tournament may never be sanctioned. | **Open: organizer.** No: only created tournaments. Planned ones are in user feeds, as tentative |
| Q2 | How long is an event when play-tools gives no end? | **Open: organizer.** 4 hours for a tournament; a play session's own end, else 3 hours |
| Q3 | Should a user feed include the league's play sessions too? | **Open: organizer.** No: a professor who wants them also subscribes to the public feed |
| Q4 | Is 30 days back and 26 weeks ahead the right range? | **Open: organizer.** Yes |

## Tests these decisions need

- **Pure:** the iCalendar writer (escaping, folding at 75 octets across multi-byte characters, CRLF, UTC times, a
  parse round-trip with a fixture checked against an RFC 5545 validator once); the event projection (summary,
  description, location, default lengths, the user's part); `UID` stability across create and reschedule; `SEQUENCE`
  bumps only on a content change; the cancellation rules, including that a failed source never cancels.
- **Module (real SQLite):** mint, rotate, turn off, one feed per kind, lookup by digest, feeds deleted with a removed
  professor and hidden for a non-member; snapshot carry-forward per source and the 14-day stale mark; single-flight
  refresh.
- **Server, over HTTP, with the fake play-tools:** the auth matrix (no secret, malformed, unknown, rotated, a session
  cookie, an integration token, a non-member's feed: all the same 404); public and user feed contents for owner,
  professor, lent professor and staff; nothing personal in the public feed; `ETag`/`304`; `HEAD`; the rate limits;
  no play-tools call on a fetch with a fresh snapshot; a professor's failed read keeps their events; the secret never
  in a log line or a response other than the mint.
- **E2E:** turning a feed on shows the link once, then only its hint after a reload; rotating changes the link;
  a professor sees no public-feed controls.
