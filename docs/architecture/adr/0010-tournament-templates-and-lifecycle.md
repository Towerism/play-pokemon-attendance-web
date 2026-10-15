# ADR-0010: Tournament templates, schedules and lifecycle (create, cancel, reschedule)

- Status: Accepted (2026-10-12, M9)
- Date: 2026-10-12
- Updated: 2026-10-13 ([#100](https://github.com/Towerism/play-pokemon-attendance-web/issues/100), from the PR #83 review;
  accepted by the organizer when its PR merges): an uncertain create is never resent automatically (`unknown`); edits
  pass every field they don't change through from the raw read; adoption skips tournaments already linked; rows a job
  holds are `creating`; the back-dating window is checked at send time; template updates name the overrides that
  shadow them. See [Update (#100)](#update-100-no-duplicate-creates-no-wiped-fields).
- Updated: 2026-10-13 ([#90](https://github.com/Towerism/play-pokemon-attendance-web/issues/90), from S8 part 2): an
  edit sends only the changed fields, which replaces the raw-read passthrough and `edit_body_unmappable`. See
  [Update (#90)](#update-90-the-edit-body-is-only-the-changed-fields).
- Updated: 2026-10-13 ([#91](https://github.com/Towerism/play-pokemon-attendance-web/issues/91), building the module):
  a template keeps its venue's country, schedules are archived rather than deleted, archiving what is still used is
  refused, and a schedule doesn't plan an event a planned row already holds. See [Update (#91)](#update-91-what-the-module-keeps).
- Updated: 2026-10-13 ([#92](https://github.com/Towerism/play-pokemon-attendance-web/issues/92), building creation):
  adoption reads a candidate's details for its format, which a listing doesn't carry. See
  [Update (#92)](#update-92-adoption-reads-the-format).
- Updated: 2026-10-13 ([#93](https://github.com/Towerism/play-pokemon-attendance-web/issues/93), building edit and
  reschedule): the reschedule rules apply to a date change, an uncertain edit is settled by one re-read, and rows a
  schedule override shouldn't change are held. See [Update (#93)](#update-93-edit-and-reschedule-as-built).
- Updated: 2026-10-14 ([#95](https://github.com/Towerism/play-pokemon-attendance-web/issues/95), building required
  events): coverage reads the `US` windows, shows the previous period, takes status from the listing's application
  state, is `unknown` with no connection, and keeps play-tools traffic paced and shared. See
  [Update (#95)](#update-95-required-events-as-built).
- Updated: 2026-10-15 ([#162](https://github.com/Towerism/play-pokemon-attendance-web/issues/162), the organizer): a
  one-off **New tournament** may change any of its template's details but the organizer and the game (decision 4), and
  Required events moves from the top of Tournaments to its own tab, with the banner on the other tabs (decisions 10
  and 12). See [Update (#162)](#update-162-one-offs-change-any-detail-required-events-gets-a-tab).
- Amends: architecture §2 (tournament creation was a non-goal), [ADR-0007](0007-staff-assignment.md) decision 1
- Builds on: [ADR-0004](0004-idempotent-diff-based-submission.md) (plan → execute → reconcile),
  [ADR-0009](0009-tournaments-as-their-organizer.md) (act on a tournament only as its organizer)
- Amended by: [#102](https://github.com/Towerism/play-pokemon-attendance-web/issues/102): required-events coverage on
  failed reads (`unknown`, never `missing`) and cadence periods (decision 12)
- Upstream contract: spike S8 ([spikes.md](../spikes.md#s8-tournament-lifecycle-and-tdf-upload-part-1-done-2026-10-12)), part 1 done, live capture pending

## Context

Staff credits already go through this app (M8). The organizer wants the rest of a tournament's life handled here
too, all of it features play-tools already has:

- **creating** a tournament;
- **cancelling** one;
- **scheduling**: giving it its date and time, and moving it to another;
- **templating**: most of the league's tournaments are the same event held regularly (weekly, monthly, or once
  a quarter), so the app should scaffold them instead of the organizer filling play-tools' four-step form each time;
- **back-to-back scaffolds**: some tournaments are always held together (for example a TCG Cup and a VGC Cup on
  the same afternoon), so one scaffold should produce the whole set;
- **submitting the TDF** after the event, on This week, in the same card as staff (ADR-0011);
- **never missing a required event** (organizer, 2026-10-12): every quarter needs a **League Cup** for each of the three
  games (TCG, GO, VGC), and every month a **League Challenge** for each. A league can get into trouble if one is
  missed (decision 12).

The organizer on rescheduling (2026-10-12): removing a tournament means **cancelling** it. If play-tools lets a
professor change the date, **reschedule with that edit** rather than cancelling and creating again.

What S8 part 1 found in the play-tools bundle:

- **Create** is `POST core/tournament` with name, league (`activity_group_id`), organizer, product, format
  (`category`), premier series (`series_guid`, or `null` for a custom event), venue (`address_id`, from the
  organizer's address book), start time, contact details, registration window and cost, details and website.
- **Cancel** is `PATCH core/tournament/{guid}/ {application_state: "cancelled"}`. It is open to the organizer while
  the tournament is `sanctioned`, `approval-pending` or `sanctioning-error`, not completed, and within start + 90 days.
  **Delete is admin-only** in the client.
- **Edit** is `PATCH core/tournament/{guid}/` with the create body. A professor may change the date until start +
  90 days, but not the league, the event type or the premier series. The new date must stay inside the series'
  window (premier) or the play cycle (custom). The form warns "Editing this information may invalidate the
  tournament".
- **There is no idempotency key, no template and no recurrence** for tournaments upstream. play-tools' Clone only
  pre-fills its form.
- A premier series (League Challenge, League Cup, …) has a date window per country; a custom event must fall in the
  play cycle. A start may be up to 72 h in the past, and there is no lead time.
- A new tournament may start `approval-pending` or end `sanctioning-error`. That is upstream's decision.
- **Errors on create, edit and cancel carry no translated codes.** The client shows a generic message and the
  `x-correlation-id` header.

Correctness of what goes into play-tools is still the first quality attribute (§2). For tournaments, the worst
outcomes are **a duplicate tournament** (players register for the wrong one) and **a tournament silently removed**.

## Options considered

1. **Leave creation in play-tools; only link to it.** No risk, and no streamlining. It doesn't meet the request.
2. **Templates only:** a one-click "create from template" for a chosen date. Saves the form, but every week still
   needs a visit and a date pick, and back-to-back events are several clicks.
3. **Templates + scaffolds + schedules, materialised as planned tournaments the organizer creates with one click.**
   The app works out upcoming dates. Nothing goes upstream until the organizer says so.
4. **As 3, but a scheduled task creates the planned tournaments upstream on its own.** Least effort, but it makes
   official records nobody looked at, at machine-chosen moments (§11 ToS risk: "no calls the organizer wouldn't make
   by hand"), and a wrong template would quietly multiply.
5. **As 3, plus "create through a date":** on a schedule the organizer picks a date X, and the app creates every
   tournament the schedule plans up to and including X in one go (for example a monthly tournament on the 3rd
   Tuesday, created through the end of the year). It is one click for many dates, with an explicit end, and no
   machine-chosen moments.

## Decision

Option 5 (organizer, 2026-10-12: "Automatic creation can occur for an explicit horizon. Say for example a monthly
tournament, the 3rd tuesday every month." and "it means create everything up to date X."). Every schedule works as
option 3, and any schedule can also be created through a chosen date (decision 5). There is no rolling or background
creation.

### 1. Scope

Tournament creation, cancellation, rescheduling and **editing any of a tournament's fields** (organizer,
2026-10-12; decision 11) move into scope as **G7** (M9). Templates, scaffolds and schedules are the app's own. Still
out of scope: running a tournament (TOM does that), per-division registration times and costs, admin actions (delete,
un-cancel, approve), and roster-only uploads.

### 2. A new `tournaments` module

`server/modules/tournaments/` owns templates, scaffolds, schedules, planned tournaments and TDF result uploads
(ADR-0011). It reaches upstream only through `PlayToolsGateway`, uses `staffing` only through `StaffingService`
(to move a rescheduled tournament's assignments, decision 8), and connections only through
`PokemonConnectionService`. Its jobs run on the submission rails
(decision 7). `staffing` stays as it is.

### 3. Vocabulary

- **Template:** one tournament's settings. It holds:
  - name (≤ 80, with optional `{month}`, `{year}` and `{date}` tokens filled from the tournament's date);
  - the **organizer**: one connected professor, who it is created as (ADR-0009);
  - product and format (`category`, from `core/products` for the venue's country);
  - **tournament type**: picked from a dropdown **read live from play-tools**, never a list built into the app
    (organizer, 2026-10-12: the types offered depend on when the tournament is sanctioned; decision 6). The template
    stores what was picked as `custom`, or `premier` with a **series match** taken from the picked series' name (e.g.
    "League Challenge"), so the series itself is resolved per date (decision 6);
  - venue (an address-book entry of the organizer: id, label and timezone are kept);
  - the usual start time (local to the venue);
  - registration: `on_site` (opens N minutes before the start, closes M minutes after, admission text) or
    `third_party` (a URL);
  - contact email and/or phone, details, event website.

  A template carries **no staff** (decision 9).

  A template can be archived, never deleted while a planned tournament refers to it.
- **Scaffold:** an ordered list of **slots**. Each slot is a template, a day offset (0 = the scaffold's date, up to
  6) and an optional start time that overrides the template's. A scaffold with one slot is a single tournament.
  Back-to-back events are one scaffold with several slots (two at 12:00 and 16:00, or Saturday and Sunday).
- **Schedule:** a recurrence for one scaffold, with a first date, an optional last date, a horizon, and a pause
  switch. Rules (a deliberately small set, not RFC 5545):
  - `weekly`: a weekday, every N weeks (1–4);
  - `monthly`: the nth (1–4 or last) weekday of the month, or a day of the month;
  - `quarterly`: the nth weekday of the first, second or third month of each quarter. Quarters follow the calendar,
    which is also how premier series windows run.

  The horizon is how far ahead the app plans: 8 weeks by default for weekly, 3 months for monthly, 2 quarters for
  quarterly, and 1 to 26 weeks in any case.
- **Planned tournament:** one tournament the organizer wants on one date, from a schedule's slot or created one-off
  from a template. It is desired state, like a staff assignment (ADR-0007), and carries the upstream `guid` and
  `display_id` once the tournament exists.

The recurrence engine is a pure function in `shared/schedule/` (dates in, dates out; no clock, no I/O, no
dependency), heavily unit-tested across month ends, leap years and DST. Local date + start time become a UTC instant
in the **venue's** timezone through the existing `local-time` helpers, moved to `shared/` if both sides need them.

### 4. Planning is local and on read

- **Materialised on read.** Reading the upcoming tournaments upserts each active schedule's occurrences from the
  **creatable window's start** (today − 2 days, decision 6) to the end of its horizon (unique on schedule, slot and
  date), so a tournament held yesterday that was never sanctioned is still there to create. Planning needs no scheduled task, and nothing depends on the server
  having been up. **Create through a date** (decision 5) materialises the same way, up to its date even when that is
  past the horizon.
- **Editing a schedule or scaffold** replans only what hasn't reached play-tools: `planned`, `skipped` and `failed`
  rows that no longer fit are deleted, new ones added. Rows in `creating` (held by a running job), `unknown` (a create
  may have landed) or `created` are kept, and shown as "no longer in the schedule" when they don't fit (#100). **A
  created tournament is never cancelled, moved or recreated because a schedule changed.** It is shown as "no longer
  in the schedule", with Cancel and Reschedule offered.
- **One planned row per event.** A one-off planned tournament (**New tournament**, **Plan one…**) with the same
  template, local date and start time as a planned row that isn't cancelled is refused (409 `already_planned`, naming
  that row) (#100).
- **Skipping** a date (a holiday) is local: the row becomes `skipped` and is never created.
- **Templates are read at creation time.** A planned tournament takes the template's settings when it is created, so
  editing a template changes every tournament not created yet, and none that exist.
- **Reminders.** This week shows "N planned tournaments from 2 days ago to 2 weeks ahead aren't in play-tools yet", with a
  button to create them. A schedule shows how far it has been created ("in play-tools through 2026-12-31").

### 5. Creating: a `tournament_create` job

A `tournament_create` job is started in two ways, both by the organizer: **Create in play-tools** on chosen planned
tournaments, or **Create through date…** on a schedule (below). Both run the same job.

**Create in play-tools** takes 1–60 planned tournaments and starts one job of `kind = 'tournament_create'` on the
submission rails. Each is created as its template's organizer. A planned tournament whose organizer can't act is not
started (`organizer_not_connected`, `needs_reconnect`), as for staff. Every planned row the job takes becomes
`creating` in the same transaction that starts the job, so replanning can't delete it (decision 4).

- **Plan.** For each planned tournament, as its organizer:
  - list their tournaments on that date in the league's activity group (`listTournaments`);
  - **adopt instead of create:** a live (not `cancelled`, `deleted` or `invalidated`) tournament with the same start
    instant, product, format and name (compared case-insensitively) is that planned tournament, **unless its `guid`
    is already linked to another planned tournament of the league that isn't cancelled** (#100). Its `guid` is
    stored and the item is `already_exists`. Nothing is sent. This is how a retry, a crash or a tournament the
    organizer made in play-tools by hand never produces a second one. A `guid` is linked to at most one planned
    tournament (a unique index), so two identical slots create two tournaments, and one tournament never shows as
    two;
  - resolve the series and venue (decision 6). Anything unresolved fails that item before any call.
- **Execute.** One `POST core/tournament` at a time, at least `NUXT_TOURNAMENT_DELAY_MS` apart (default 5 s, never
  under 2 s). The token is fetched for each call.
  - **The creatable window is checked again just before each `POST`**, with the job's clock and the league `TZ` at
    that moment (#100). A job that runs past midnight can push an item out of it. That item ends
    `date_too_far_past`, and nothing is sent for it.
  - **A 5xx, a timeout or a dropped connection means "may have landed"** (as for `_bulk`, ADR-0004 update). The job
    re-lists for a settle window (default 3 min) and adopts a match. **It never sends that create again** (#100):
    ADR-0004 saw a failed call land a minute later, and nothing bounds that. With no match by the end of the window,
    or if the re-listing itself fails, the item is `unknown` and the planned tournament becomes `unknown`. Its
    support details say the tournament may still appear in play-tools.
  - **A 4xx is that item's outcome**, `refused`, with upstream's message and the correlation id (S8 found no codes).
    The job goes on with the rest. A 401 or 403 stops the job (`forbidden`).
- **Reconcile.** Re-read each created tournament (`getTournament`) and store its `guid`, `display_id` and status.
  `approval-pending` and `sanctioning-error` are shown as they are; the app doesn't chase approval.
- **Outcomes:** `created`, `already_exists`, `refused`, `failed`, `skipped`, `unknown`, `date_too_far_past`.
- **An `unknown` tournament** (#100):
  - **is linked on read.** Every read that already lists the organizer's tournaments for its date (Upcoming, This
    week, the create-through list, a create job's plan step) runs adoption for it. A match is linked and the row
    becomes `created`, with no upstream write and no extra call;
  - **is created again only by a click.** **Retry create** starts an ordinary create job, which lists and adopts
    first. Its dialog says when the earlier attempt was sent and that it may still land (organizer, 2026-10-13:
    allowed at any time, with that warning). The route takes `retryUnknown: true` for `unknown` rows, else 422
    `retry_not_confirmed`;
  - **after a rename upstream** isn't matched. The retry dialog lists the organizer's tournaments on that date, so a
    copy made under another name is seen before anything is sent;
  - **when skipped** locally is still linked if it later appears, and shows as "in play-tools, skipped here" with
    Cancel offered. It is never cancelled automatically.
- **Boot recovery.** An interrupted job's `creating` rows become `unknown` if their `POST` was sent (`sent_at` is
  set just before it), and `planned` if it wasn't.

**Create through a date.** On a schedule, **Create through date…** takes a date X and creates every tournament the
schedule plans from the creatable window's start (today − 2 days, decision 6) up to and including X, in one
`tournament_create` job. Example: monthly, 3rd Tuesday,
through 2026-12-31 creates October's, November's and December's 3rd-Tuesday tournaments (every slot of the scaffold
for each date).

- **Explicit and listed first.** X is required, at most 12 months ahead. The schedule is materialised up to X (past
  its planning horizon if need be), and the dialog lists every tournament it will create, with the ones it leaves
  out: `skipped`, already in play-tools, or before the creatable window. Skipping a date in the list leaves it out. Nothing is created until
  the organizer confirms.
- **One job, up to 60 tournaments**, oldest first, run like any other create: adopt before create, as each template's
  organizer, paced, under the lease, in History as "Create <scaffold name> through <X>". More than 60 is refused
  (`too_many_tournaments`), and a nearer date is suggested.
- **Nothing in the background.** The app never creates a tournament on its own. After the job, the schedule shows
  "in play-tools through X". Dates after X stay planned, with the usual reminder, until the organizer creates them or
  runs **Create through date…** again with a later date. Running it again for the same or an earlier date creates
  only what is missing, by adoption.
- **Failures are listed in the job's result** and stay `failed` on the planned tournament, retried by a click:
  - an upstream refusal (`refused`), a missing venue (`venue_not_found`) or an ambiguous series
    (`series_ambiguous`);
  - `series_not_found`, which is expected far ahead because a later quarter's premier series may not be published
    yet. The result says so.
- **Not a reschedule or a cancel.** It only creates. Editing or pausing a schedule never cancels or moves a
  tournament already created (decision 4).

### 6. Series and venue are resolved, not stored

- **Tournament types are always read from play-tools, for the date** (organizer, 2026-10-12: which types can be
  sanctioned depends on when). The app keeps no list of types. Every type dropdown is filled from
  `listSeries` (as the organizer, for the league) at the moment it is shown:
  - **a form with a date** (a one-off **New tournament**, a planned tournament, the create-through list, **Edit…**)
    offers **Custom** plus every premier series play-tools offers for that date: the product matches, and the series'
    window for the venue's country contains the date. Its format dropdown follows the picked series' formats
    (`category_slugs`), or `listFormats` for a custom event;
  - **a template** (no date of its own) offers **Custom** plus the series play-tools offers across its schedules' next
    planned dates (or the coming 12 months, when no schedule uses it yet). Picking one stores its series match. The
    template form shows which upcoming dates it matches and which it doesn't;
  - options are read fresh each time a form opens (a short cache, at most 10 minutes, as the organizer), so a type
    play-tools adds or withdraws shows up without an app release.
- **Series per date.** For a `premier` template, the series is the one from `listSeries` whose product matches, whose
  name contains the series match, and whose window for the venue's country contains the date. None is
  `series_not_found`, and several are `series_ambiguous`. Either way the planned tournament shows the live type
  dropdown for its date, and the organizer picks a type (a stored override). The pick may be Custom, or a series under
  a new name. A `quarterly` schedule therefore follows the new series each quarter with no edit.
- **Edit… shows the type read-only**: play-tools doesn't let a professor change a tournament's event type or series
  (S8).
- **Venue.** The template keeps the address-book id. A venue no longer in the organizer's address book is
  `venue_not_found`, and the organizer picks another on the template.
- **Dates.** The app doesn't mirror upstream's series windows or cycle end. Like eligibility for staff (ADR-0007
  decision 10), they are upstream's call, and the planner shows the series window it found.
- **Sanctioning after the event: the last 2 days** (organizer, 2026-10-12). A tournament held in the last 2 days that
  was never put in play-tools can still be created, so it can be sanctioned and its TDF uploaded. The **creatable
  window** starts at **today − 2 days**, in the league `TZ`, and has no end before the 12-month limit:
  - every way of creating takes a date in it: **Create in play-tools** on a planned tournament, a one-off **New
    tournament** from a template, and **Create through date…** (decision 5). So does a reschedule (decision 8);
  - Upcoming, This week (its date picker already reaches back), the reminder and the create-through list show
    planned tournaments from that start;
  - a date before it is refused locally (`date_too_far_past`) before any call. A job checks it again just before
    each send, so an item that falls out of the window while the job runs (past midnight) is refused then (#100);
  - it fits upstream's own limit: S8 found play-tools' form takes a start up to 72 h in the past (its message), and
    its code allows 84 h. The start of today − 2 days is less than 72 h before any moment today, and at most 73 h
    across a DST fall-back, still inside 84 h. S8 part 2 confirms what the server enforces (Q5);
  - a back-dated tournament is created like any other (adopt before create, as the organizer, paced). If play-tools
    refuses it anyway, the refusal is the item's outcome (`refused`), as for any create.
- **Sanction at least 7 days ahead: a guideline, not a block** (organizer, 2026-10-12: tournaments not in the past
  must be sanctioned at least 7 days in advance, but it isn't a hard and fast rule).
  - **Sanction by.** Every planned tournament shows a **sanction-by date**: its date − 7 days, in the league `TZ`. The
    Upcoming tab, This week's reminder and the create-through list sort and highlight by it ("Create by Tue 20 Oct").
  - **Short notice is a warning.** Creating a tournament whose date is today through 6 days ahead, or moving one
    there by edit or reschedule (decisions 8 and 11), is allowed. The dialog lists each such tournament as **short
    notice** ("less than 7 days before it is held; the league is expected to sanction 7 days ahead"). The organizer
    confirms (**Create anyway** / **Save anyway**), and the server refuses a request without
    `acknowledgeShortNotice: true` when any are short notice (422 `short_notice_not_acknowledged`), as for TDF
    warnings (ADR-0011). Who acknowledged it is kept on the job.
  - **Not short notice:** a tournament already held (back-dated, above) is after the fact, not short notice, and a
    date 7 or more days ahead needs no warning.
  - **Create through date…** includes short-notice dates with the same warning. Nothing is left out for being soon.
  - S8 found no lead time in play-tools' client. If play-tools turns out to enforce one, its refusal is the item's
    outcome as usual (Q5).

### 7. Same rails as every other job

Creation, cancellation, editing (rescheduling included) and TDF confirmation are `submission` rows with new kinds
(`tournament_create`, `tournament_cancel`, `tournament_edit`, `tdf_upload`). They get the per-league lease (one job of any kind at a
time, so play-tools sees one call at a time), the event log and SSE, History, retry that re-reads first, boot recovery
and shutdown. Their per-tournament items go in a new `submission_tournament_item` table, because `submission_item`
is per player.

- **Permissions are play-tools' business** (organizer, 2026-10-12). The app assumes every connected professor has
  the rights each action needs: create, edit, cancel, upload, and reading series and venues. It keeps no role model of
  owners or league assistants, and never hides an action on a guess.
- **Every refusal carries support details.** When play-tools refuses an action, the item's outcome shows play-tools'
  own message. It also shows a copyable **support details** block, the same as ADR-0011's for TDF uploads. A
  permission refusal (401, 403), a 4xx with no code, and any other refusal are covered. The block has enough for
  Pokémon support to find the call and fix the account:
  - the action (create, edit, reschedule, cancel, read series or venues, TDF validate or confirm) and when it was sent;
  - the league's display id and the tournament's display id and name (or, for a create, the date and name it
    would have had);
  - the professor it ran as: player id and display name;
  - the HTTP status, play-tools' error code and message as returned, and the `x-correlation-id` response header.

  It holds no tokens, no request body and no player data. History keeps it with the job. A 401 or 403 still stops
  the job (`forbidden`), and its message says the connected account may lack the permission for that action.

### 8. Cancelling, editing and rescheduling are explicit, and never automatic

**Cancel** (`kind = 'tournament_cancel'`, one tournament):

- **Offered** for any tournament of the league a connected professor organizes, made here or in play-tools, while
  upstream allows it (S8: `sanctioned`, `approval-pending` or `sanctioning-error`; not completed; within start + 90 d).
- **Confirm dialog** from a fresh read. It names the tournament, its date and display id, and how many players and
  staff it lists. When anyone is registered, the organizer types the display id, as Clear session asks for the date.
- **As the organizer.** It sends `PATCH core/tournament/{guid}/ {application_state: "cancelled"}`, then re-reads.
  An already cancelled tournament is `already_cancelled`, and nothing is sent.
- **Afterwards.** The planned tournament becomes `cancelled`. Its staff assignments that never reached play-tools
  are dropped, and the rest are marked removed locally. Nothing more is sent.

**Reschedule** is an edit of the date and start time (a `tournament_edit` job, decision 11) that **changes the date
in place** (organizer, 2026-10-12: use the `PATCH` when play-tools allows it). On top of decision 11's rules:

- **One call, as the organizer.** The job reads the tournament fresh (`getTournament`), then sends `PATCH
  core/tournament/{guid}/` with the new start. The registration window moves by the same amount, so its offsets from
  the start are kept. The body is built as decision 11 says: the raw fresh read with only the dates changed and
  every other field passed through as play-tools returned it, unless the live capture shows a partial body is
  accepted (Q1). *It did: the body is only the new dates ([Update (#90)](#update-90-the-edit-body-is-only-the-changed-fields)).*
- **Same tournament.** The `guid`, display id, registrations and staff stay. The planned tournament and its wanted
  staff assignments move to the new date locally. No staff call is needed.
- **Refused locally** before any call, from the fresh read:
  - **outside the reschedule window**: a reschedule can be attempted **from 3 days before the tournament's current
    start to 90 days after it** (in the league `TZ`; organizer, 2026-10-12):
    - earlier is `reschedule_window_not_open`. The dialog says the date it opens, and that **Cancel…** and a new
      tournament are the way to move it sooner;
    - later is `reschedule_window_closed`.

    Edits that don't change the date aren't bound by this window. They keep play-tools' own 90 days
    (`tournament_locked`, decision 11). A tournament not in a state play-tools lets a professor edit is refused as
    well;
  - for a premier event, a new date outside its series' window for the venue's country (`outside_series_window`).
    A professor can't change the series, so moving a League Cup into another quarter means cancelling it and making
    a new one, which the dialog says;
  - a new date before the creatable window (today − 2 days, decision 6): `date_too_far_past`. The job checks it
    again just before the `PATCH`, with its own clock (#100).
- **Another planned tournament at the new time.** When another planned row of the same template already holds the
  new date and start, the preview warns ("another planned tournament is at that time", `another_planned_at_time`).
  It doesn't block (#100).
- **Re-read, never re-send blindly.** A tournament already at the new start is `already_applied`, and nothing is
  sent. After a 5xx the job re-reads, and the edit counts as landed when the start matches.
- **Status afterwards.** If play-tools moves the tournament back to `approval-pending` (or `sanctioning-error`), the
  outcome says so, and the card shows it. The confirm dialog warns that play-tools may re-check the tournament.
- **Fallback, only if the live capture shows a professor can't change the date:** cancel, then create on the new date
  with the same settings, in one job, cancel first. It would track `replacing` / `recreate_pending` so a stopped job
  is visible and resumable, and move the wanted staff to the new tournament as `pending`. That would need this ADR
  updated and the organizer's approval before it is built.
- **A schedule never reschedules.** A planned tournament that hasn't reached play-tools is just edited (date, time).

### 9. Templates carry no staff

Staff are chosen per tournament, on This week's tournament card, as today (ADR-0007), once the tournament exists in
play-tools (organizer, 2026-10-12). Creating a tournament adds no staff assignments. The staff list search already
pre-fills each staffer's last role, so a regular crew is quick to add.

### 10. Where the organizer does it

- **A new Tournaments page** (`tournaments.vue`, in the nav), with three tabs:
  - **Upcoming:** planned and upstream tournaments from 2 days ago through the coming weeks, by date. Each shows its status (planned,
    skipped, in play-tools, approval pending, sanctioning error, cancelled, or **unknown**: a create that may have
    landed, with **Retry create**; decision 5) and offers
    **Create in play-tools** (one, or every selected), **Skip**, **Edit…** (decision 11; rescheduling is editing the
    date), **Cancel…** and **Download TDF** (only when the app holds the tournament's results file; ADR-0012
    decision 7, #107). A one-off
    **New tournament** comes from a template and a date, which may be up to 2 days in the past.
  - **Templates:** list, create, edit, archive. The form's choices (formats, series, venues) are read live from
    play-tools as the template's organizer.
  - **Schedules:** scaffolds (slots: template, day offset, start time) and their recurrence, with a preview of the
    next dates before saving.
- **This week** turns each Staff card into a **tournament card**: its status, its Staff section (as built), and a
  Results section for the TDF (ADR-0011). A date with planned tournaments not yet created shows them, with
  **Create in play-tools**. The card's menu offers **Edit…**. Cancel stays on the Tournaments page, away from the
  weekly flow.

### 11. Edit any field, and optionally apply it across the schedule

The organizer (2026-10-12): editing any of a tournament's fields is in scope, and a tournament that is part of a
schedule can have the change applied to other tournaments in the schedule.

- **Edit…** is offered on any tournament of the league that a connected professor organizes, made here or in
  play-tools, while play-tools lets a professor edit it (within start + 90 d, not cancelled or complete; S8; a date
  change only from start − 3 d to start + 90 d, decision 8). The
  form is the template form, pre-filled from a fresh `getTournament` as the organizer:
  - **editable:** name, format, venue, date and start time, registration (on-site window and admission, or
    third-party URL), contact email and phone, details, event website;
  - **read-only,** because play-tools doesn't let a professor change them (S8): league, organizer, event type,
    premier series, and a premier event's product.

  A planned tournament not yet in play-tools is edited locally, with no upstream call.
- **Only what changed is sent.** The form is compared with the fresh read. The job applies just the changed fields onto
  a fresh read of each tournament, then sends `PATCH core/tournament/{guid}/`: the full body, or only the changed
  fields if S8 part 2 shows a partial body is accepted (Q1). An edit made meanwhile in play-tools to another field is
  never overwritten.
- *Superseded by [Update (#90)](#update-90-the-edit-body-is-only-the-changed-fields): S8 part 2 showed a partial
  body is accepted, so only the changed fields are sent, and `edit_body_unmappable` is gone.*
  **The full body is the raw read, not the create body** (#100). The app doesn't model every field: per-division
  times and costs (`activity_division_info`) are out of scope, and the create body sends them as `null`. So a full
  body is built **inside the adapter** from the raw `GET` of that tournament: the changed fields are replaced, and
  every other field is sent back with the value play-tools returned, including ones the app doesn't know. If the raw
  read has a field the adapter can't map from its read shape to its write shape, the edit is refused before any call
  (`edit_body_unmappable`, naming the field), never sent with that field dropped or `null`. The port stays
  `editTournament(id, changes)`, and no raw shape leaves the adapter. A contract test against a recorded S8 part 2
  read with every field set (non-null `activity_division_info` included) checks that only the changed fields differ.
- **A `tournament_edit` job,** as the organizer, one tournament at a time, paced like creation:
  - re-read, then send;
  - every changed field already at its new value is `already_applied`, and nothing is sent;
  - after a 5xx, re-read and compare before anything else;
  - outcomes: `edited`, `already_applied`, `refused` (upstream's message and correlation id), `failed`, `skipped`.
    A tournament play-tools sends back to `approval-pending` says so;
  - refused locally, before any call: `tournament_locked`, `date_too_far_past` (checked again just before the
    `PATCH`), `outside_series_window` (decision 8), `format_not_in_series` (a premier event's format must be one of
    its series' formats), `venue_not_found` (`edit_body_unmappable` was dropped by Update #90).
- **Applying it across the schedule.** When the tournament came from a schedule, the dialog asks where the change
  goes:
  - **This tournament only** (the default);
  - **This and later tournaments in the schedule**;
  - **All tournaments in the schedule**, from the creatable window's start (decision 6). Earlier ones are history and
    are not touched.

  It applies to the same scaffold slot (the same event on each date). A tick adds **the tournaments held with it**
  (the scaffold's other slots on those dates), for fields that make sense across them (venue, contacts,
  registration, details, website).
  - **Per-field ticks.** Each changed field has a tick, all on except two:
    - **the date never carries over.** Moving one week doesn't move the others. A start-time change carries over
      as a time of day, keeping each tournament's own date;
    - **the name is off by default,** since names often carry their month or date. Ticked, the new name is used as
      typed.
  - **Preview before anything is sent.** Every affected tournament is listed with each field's before → after, in
    three groups:
    - **in play-tools** (will be edited);
    - **planned** (updated locally);
    - **left out**, with why: cancelled, complete, locked, or before the creatable window.

    The organizer can untick any tournament. Nothing changes until they confirm.
  - **In play-tools:** one `tournament_edit` job with one item per tournament, oldest first, at most 60, each with
    its own outcome. One refusal doesn't stop the others.
  - **Not created yet:** the changes are stored as **overrides**, so those tournaments are created with them. They go
    on each planned row in the range (`PLANNED_TOURNAMENT.overrides`). For "this and later" and "all", they also go on
    the schedule (`TOURNAMENT_SCHEDULE_OVERRIDE`: slot, effective from a date, fields), so dates planned later get
    them too. At creation, the settings are the template, then the schedule's overrides in effect for that date, then
    the row's own.
  - **The template is untouched** unless the organizer also ticks **Update the template**. That changes future
    creation for every schedule using it, and those schedules are listed first, **except where an override of the
    same field wins** (#100). The preview lists each schedule and date range whose schedule or row overrides shadow
    the change. **Also clear these overrides** removes those override fields in the same apply. It is **off by
    default** (organizer, 2026-10-13), since overrides are usually deliberate.
- **A tournament made in play-tools** (not from a schedule) is edited on its own. There is no schedule to apply to.
- **A date change** moves the tournament's local staff assignments with it (decision 8). Other fields don't touch
  staff.

### 12. Required events: never miss a League Cup or a League Challenge

The organizer (2026-10-12): every quarter needs a League Cup for each of TCG, GO and VGC, and every month a League
Challenge for each. Missing one can get the league into trouble. So the app tracks this as **coverage**, separate from
schedules: a schedule is how events usually get planned, and coverage is the check that nothing slipped through.

- **Requirements are data, seeded with the organizer's six.** A `TOURNAMENT_REQUIREMENT` row holds:
  - the tournament type, as a series match against play-tools' series names ("League Cup", "League Challenge");
  - the product: `tcg`, `pgo` (GO) or `vg` (VGC);
  - the cadence: `month` or `quarter`;
  - the minimum count (1);
  - an on/off switch.

  The seeds are League Cup × {TCG, GO, VGC} quarterly and League Challenge × {TCG, GO, VGC} monthly. They are edited
  on the Tournaments page, and a league that doesn't run a game turns its rows off. Types stay play-tools' own
  (decision 6): a requirement whose match finds no play-tools series for a period says so ("play-tools offers no
  series matching 'League Cup' for GO this quarter"), so a renamed type is noticed instead of silently counting as
  missing.
- **Periods come from the cadence** (#102). A requirement's period is always its cadence's calendar period in the
  league `TZ`: the calendar month for `month`, and the calendar quarter (Jan–Mar, Apr–Jun, Jul–Sep, Oct–Dec) for
  `quarter`. A series window never widens, narrows or replaces it, so a League Challenge series that runs a whole
  quarter still leaves each month needing its own Challenge. Coverage looks at the current period and what follows:
  the next 3 months, and the current and next quarter. A manual cover's `period_start` is the period's first day.
- **The series window says how late, not which period.** For each period, the **latest date** a covering tournament
  can be held is the earlier of the period's end and the end of the latest matching series window (product, the
  league's country) that overlaps it. Urgency counts from the latest date (below), and **Plan one…** suggests dates
  inside both the period and a matching series window. When no matching window overlaps the period, the cell says
  "play-tools offers no series matching 'League Cup' for GO in Q4", and its urgency counts from the period's end.
- **What counts.** A tournament covers a requirement's period when its product matches, its series name matches, and
  its start's local date in the league `TZ` falls in the period. The series window isn't consulted for a tournament
  play-tools already holds: play-tools sanctioned it in that series. Tournaments are taken:
  - from play-tools: every connected professor's tournaments in the league's activity group (ADR-0009), with each
    tournament's series from its details. The details are read once per tournament and cached by `guid`, since a
    professor can't change a series;
  - from the app: planned tournaments not yet created, whose template and date resolve to a matching series.
- **Status of each requirement in each period,** best first:
  - `sanctioned`: a live tournament is sanctioned (or already complete);
  - `pending`: the best is `approval-pending`;
  - `planned`: only a planned tournament in the app, not yet in play-tools;
  - `problem`: the only match is `sanctioning-error`, which doesn't count;
  - `missing`: nothing;
  - `unknown`: a connected professor's tournaments couldn't be read (below), so the app can't tell.

  Cancelled, deleted and invalidated tournaments never count.
- **A failed read is `unknown`, never `missing`** (#102; organizer, 2026-10-13). Each professor's listing is either
  read or failed (`needs_reconnect`, `upstream_unavailable` for a 5xx or timeout, `refused` for another 4xx). A
  period that is `sanctioned` or has a manual cover keeps that status whatever failed, because a cover that has been
  seen can't be taken away. Any other period becomes `unknown` while any read failed. It names each professor whose
  read failed and why, and gives the status the readable tournaments alone would give as a hint ("can't confirm;
  known: approval pending"). The same applies to a tournament whose details couldn't be read: the cell names it. The
  route still answers 200, even when every read failed.
- **Urgency**, worked out from today in the league `TZ`, counting from the period's **latest date** (above), getting
  louder:
  - **open:** the period has started or is ahead, and it isn't covered yet;
  - **at risk:** it isn't `sanctioned` and the latest date is within the warning lead (default 21 days for monthly,
    45 for quarterly, editable per requirement). `planned`, `pending` and `problem` are at risk too: a planned
    tournament isn't in play-tools, and approval can be refused. The cell names the **sanction-by date** for a
    tournament on the latest date (the latest date − 7 days);
  - **short notice:** that sanction-by date has passed and it still isn't covered. A tournament can still be
    sanctioned by the latest date, with the short-notice warning (decision 6). The banner says so and gives the
    latest dates left;
  - **last chance:** the latest date passed less than 2 days ago and it isn't covered. A tournament held in its last
    2 days can still be sanctioned (decision 6), and the warning says which dates qualify;
  - **missed:** the latest date passed more than 2 days ago uncovered. It stays on record and in the grid's history.

  An `unknown` period keeps the urgency it would have had, so a professor whose read keeps failing never hides a
  deadline.
- **Impossible to overlook:**
  - a **Required events** grid at the top of the Tournaments page: requirements × periods, each cell showing its
    status, the covering tournament (display id, date, organizer), or the action to take, with **Refresh**;
  - on **This week**, a banner whenever anything is **at risk**, **short notice**, **last chance** or **missed** (one line per
    requirement and period, most urgent first), and **problem** whenever a tournament comes back `sanctioning-error`.
    An `unknown` period at risk or louder is worded "can't confirm" ("Can't confirm a League Cup for TCG this quarter:
    Professor Ash's tournaments couldn't be read (needs reconnect). The last date is Dec 31."). There is also one line
    per professor whose read failed, with **Reconnect** for `needs_reconnect` and **Retry** for the others;
  - a count badge on the Tournaments nav link while anything is at risk or worse.

  The banner can't be dismissed. It goes away only when the cause does: the read succeeds, or a cover is found.
- **One click to fix.** A cell that isn't covered offers **Plan one…**: a one-off **New tournament** with the type
  and game set, and a date inside the period. It uses a template that matches if there is one, and otherwise opens the
  form with play-tools' choices for that date. A `planned` cell offers **Create in play-tools**, and a `problem` cell
  links the tournament in play-tools.
- **Covered somewhere the app can't see.** play-tools lists only the tournaments a connected professor organizes (S6).
  A Cup run by another professor of the league whose account isn't connected would show as missing. **Mark as
  covered…** records a manual cover for that requirement and period, with a note (e.g. "run by Professor X, 0123-…"),
  who and when. It shows as `covered (manual)`, never as `sanctioned`, and can be removed. Connecting that professor
  (ADR-0008) makes it automatic.
- **Pure and testable.** Coverage is a pure function in `shared/requirements/`: requirements, each professor's read
  result (tournaments, or why it failed), planned tournaments, manual covers, series windows, the league `TZ` and
  today, in; statuses and urgencies out, with no clock and no I/O. It is unit-tested across period edges by local
  date, DST, the 2-day grace, series windows that differ from calendar periods, failed reads (never `missing` while
  any read failed), and cancelled or errored tournaments.
- **Read on demand, cached briefly** (#102; organizer, 2026-10-13). The grid and the banner are computed when the
  page is read. Each professor's listing for the coverage range is kept in memory for 5 minutes and shared by
  coverage, the Upcoming tab and This week, as play sessions are (§4.1). A failed read isn't kept. **Refresh**
  (`?refresh=1`) reads again, and a professor's cached listing is dropped when a tournament job of theirs (create,
  edit, cancel) ends. A warm cache makes no listing calls, and a cold one makes one per connected professor, plus one
  details read per tournament not seen before. Nothing is scheduled, and no notification leaves the app (email or
  push would be a later decision).

## Update (#100): no duplicate creates, no wiped fields

The adversarial review of PR #83 found that the two promises this ADR leads with, no duplicate tournaments and no
overwritten fields, both had holes in the default path. The fixes are folded into the decisions above, marked
(#100), and summarised here:

| Gap | Fix | Where |
| --- | --- | ----- |
| A create that got a 5xx was resent after a fixed 3-min settle window, but a late landing isn't bounded by 3 min | Never resent automatically: `unknown`, linked on read, retried only by a click | decision 5 |
| The edit body was the create body, which sends `activity_division_info: null` and wipes per-division settings | Built in the adapter from the raw read, every unchanged field passed through; an unmappable field refuses the edit | decisions 8, 11 |
| Two planned rows could adopt the same tournament | Adoption skips `guid`s already linked; a unique index; a duplicate one-off is 409 `already_planned`; an edit onto another row's time warns | decisions 4, 5, 8 |
| Replanning could delete rows a running job was working on | Rows a job takes are `creating`; replanning deletes only `planned`, `skipped` and `failed` | decisions 4, 5 |
| The back-dating window was checked only at plan time | Checked again just before each send, with the job's clock | decisions 5, 6, 8 |
| **Update the template** was silently shadowed by overrides | The preview lists the shadowing overrides; **Also clear these overrides**, off by default | decision 11 |

**Tests the build issues (#91, #92, #93) carry**, with the logic pushed down:

- **Unit:** the adoption matcher, override resolution and the creatable-window check.
- **Module** (in-memory DB and the gateway fake): the row state machine (`planned → creating → created | unknown |
  failed | date_too_far_past`) and boot recovery.
- **Server** (`test/server`, `fake-pokemon.ts`):
  - a 500 whose tournament lands 4 minutes later still gets exactly one `POST`;
  - **Retry create** adopts the late tournament, or sends one `POST` if it never landed;
  - 409 `already_planned`;
  - a schedule edit while a create is held at a gate on the fake keeps the row.
- **Contract:** every recorded S8 part 2 `PATCH` body is exactly what the adapter builds from the same changes
  (Update #90 replaced the raw-read check).
- **Determinism:** every time-dependent case uses an injected clock, never a wall-clock wait: the settle window, the
  late landing, midnight, the DST days in `America/Chicago`, and "how long ago".
- **Behaviour over mocks:** assertions read the fake's request log and the database, never mock call counts.
- **Coverage, by risk:** 100% branch coverage on the matcher, the edit-body merge and the window check, and at least
  90% on the job state machine and override resolution.

## Update (#90): the edit body is only the changed fields

**Context.** Decisions 8 and 11 built the edit body from the raw fresh read, with the changed fields replaced. Both
left an opening: "or only the changed fields if S8 part 2 shows a partial body is accepted (Q1)". S8 part 2 showed
it is. A `PATCH` with `details` or `start_date_v2` alone answered 204, and the other 32 fields read back identical.
It also showed that the read isn't the write shape: it has `series` (an object) where create takes `series_guid`,
and `address` where create takes `address_id`.

**Decision.** `editTournament` sends `PATCH core/tournament/{guid}/` with only the changed fields, under their wire
names, and doesn't read first. The jobs still read fresh before they send, for `already_applied` and the local
refusals (decisions 8 and 11). The raw-read passthrough and its `edit_body_unmappable` refusal are dropped. So is
the #100 test of an unmapped field. The contract test checks instead that each recorded `PATCH` body is exactly
what the adapter builds from the same changes.

**Trade-offs.**
- (+) A field the app doesn't model can't be wiped or echoed back stale, because it is never sent.
- (+) There is no read-to-write mapping to keep in step with play-tools.
- (−) This rests on a custom event edited after its start. If play-tools ever wants the full body for a premier
  event or an earlier edit, the refusal (`refused`, with play-tools' message) shows it.

## Update (#91): what the module keeps

Building the `tournaments` module filled four gaps the decisions above left open:

- **A venue's country.** Series windows (decision 6) and `listFormats` are per country, and the app stores no league
  country. A template keeps its venue's two-letter country with its id, label and time zone. The form options take
  `?country=` (default `US`). Storing a league country is a later decision, if a league outside the US uses the app.
- **Schedules are archived, not deleted.** A schedule whose rows reached play-tools can't lose them, so `DELETE`
  archives it and replans it as if nothing fits: rows not in play-tools go, the rest keep their schedule link.
  Templates and scaffolds were already archived (decision 3).
- **Archiving what is still used is refused.** A template used by a live scaffold (409 `template_in_use`), or a
  scaffold used by a live schedule (409 `scaffold_in_use`), isn't archived, so a schedule never plans from an
  archived template.
- **One planned row per event, in both directions.** Decision 4 refuses a one-off that duplicates a planned row. A
  schedule likewise doesn't plan an occurrence when a row that isn't cancelled already holds the same template, local
  date and start time, so a one-off followed by a schedule can't create two tournaments. Two identical slots of one
  scaffold still plan two rows (decision 5).

## Update (#92): adoption reads the format

Decision 5 adopts a live tournament with the same start instant, product, **format** and name, and says an `unknown`
row is linked on read "with no extra call". But the organizer's listing (`core/activities`, S6 and S8) carries no
format: only a tournament's details (`getTournament`) do. So:

- **A candidate is read once.** A listed tournament that already matches on start, product, league and name, and
  isn't linked to a planned row, is read with `getTournament` to compare its format. Candidates are tried in `guid`
  order. Usually there is none, so most creates add no call; a match costs one read.
- **In a create job, a failed details read is not "no match".** The item fails `listing_unavailable` and nothing is
  sent, the same as when the listing itself fails, because a duplicate can't be ruled out.
- **On read** (Upcoming, the create-through list), a candidate whose details can't be read leaves the row `unknown`.
  The read still answers.
- The listing is asked for the tournament's start instant only, so the job reads one page in the usual case.

Building the job also settled what decision 5 left to it:

- A create job's History label is "Create N tournaments" (or "Create <scaffold> through <X>"), and its professor is
  the organizer when every tournament shares one.
- **Retry** from History re-creates only the job's rows still `planned` or `failed`. `unknown` rows need **Retry create**,
  and a row that has become short notice since the job ran refuses the retry (`short_notice_not_acknowledged`).
- A held row the job never sent goes back to `unknown` if an earlier create was sent for it, else to `planned`.
- The schedule's "in play-tools through X" moves forward only when a create-through job succeeds, never back.

## Update (#93): edit and reschedule as built

Building **Edit…** settled what decisions 8 and 11 left to it:

1. **The reschedule rules apply when the local date changes.** The reschedule window (start − 3 d … start + 90 d),
   short notice, the creatable window, the series window and moving staff apply to a change of the tournament's local
   date. A new start time on the same date is an ordinary edit: decision 8 already exempts "edits that don't change
   the date", and otherwise a time change carried across a schedule could never reach a tournament more than 3 days
   out. A carried start time keeps each tournament's own date.
2. **An uncertain `PATCH` is re-read once, not settled.** An edit is idempotent, unlike a create. After a 5xx or a
   timeout the job re-reads: the change there → `edited`; otherwise the item fails `unavailable`, and **Retry** sends it
   again only after its own fresh read (`already_applied` if the first one landed late). The job never resends on its
   own. An edit in flight at a crash is `unknown`, and a retry takes it.
3. **`{id}` is a planned tournament id or a play-tools guid.** A guid a planned row holds is that row. A guid no row
   holds is read as each connected professor in turn, then acted on as the organizer the read names (ADR-0009).
4. **A tournament with no template uses country `US`** for series windows and venues, as the form options do
   (Update #91).
5. **A series play-tools no longer lists** can't be checked for a date change: the preview warns
   `series_window_unknown`, and play-tools' refusal, if any, is the outcome.
6. **A changed venue keeps each tournament's local date and start time** in the new venue's zone, so a venue in
   another zone moves the start instant. That is not a reschedule.
7. **Rows a schedule override shouldn't change are held.** For "this and later" and "all", the override goes on the
   schedule (decision 11). Rows not created yet that it would otherwise reach but the edit doesn't (excluded ones, and
   `creating` or `unknown` ones, whose create may land under their current name) keep what they resolve to now, as row
   overrides. So unticking a tournament in the preview really leaves it as it was.
8. **Refusals keep the codes the module already had:** `contact_required` stays 400 and `organizer_not_connected` 422,
   as for templates and creates.

## Update (#94): cancel as built

Building **Cancel…** settled what decision 8 left to it:

1. **"Anyone registered" is anyone listed besides the organizer:** a player or a staffer. Either one requires the typed
   confirmation, since a cancel notifies staff too.
2. **What is typed** is the display id, exactly as play-tools shows it, or the local date (`YYYY-MM-DD`) for a
   tournament with no display id. The comparison is exact, as Clear session's is. The value is in the preview, so typing
   it proves intent; it is not a secret.
3. **Cancellable** means `application_state` (else `status`) is `sanctioned`, `approval-pending` or
   `sanctioning-error`, `status` isn't one of the dead ones an edit locks on (`cancelled`, `complete`, `deleted`,
   `invalidated`), the activity isn't `completed`, and now is before start + 90 days when the start is known. Otherwise
   it is `tournament_locked`. play-tools still decides, and its refusal is the outcome.
4. **Already cancelled at apply time is not an error.** The apply answers 200 with no job and no call, after the typed
   confirmation, and does the local follow-ups under the same lease check a job takes. It is logged with who did it,
   since History has no job to show.
5. **Only tournaments in play-tools are cancelled.** A row a create holds or may have made (`creating`, `unknown`) is
   `not_editable` until it settles. Any other row with no guid never reached play-tools: `not_in_play_tools`, and
   **Skip** is the way. Any other row holding a guid (`created`, `cancelled`, or a `skipped` / `failed` row linked later,
   decision 5) can be cancelled.
6. **A 204 is `cancelled`.** The follow-ups run, then a re-read records play-tools' status on the planned row. If that
   status isn't `cancelled`, the row keeps what play-tools shows and the item says so.
7. **"Marked removed locally" is the staffing tombstone** (`removed_at`, state `removing`, as removing an assignment
   does). No staff job can send it, since staffing refuses a tournament play-tools no longer lists. This week leaves the
   tombstones off once every professor was read and nobody lists the tournament, so a cancelled tournament with only
   tombstones shows no card; the rows stay, so a cancel that turns out not to have happened still removes them
   ([#148](https://github.com/Towerism/play-pokemon-attendance-web/issues/148)).
8. **The confirmation travels with the item.** The item records whether the organizer typed the confirmation. A retry
   of a confirmed item doesn't ask again. An unconfirmed one (nobody was listed at apply) has its participants read
   again at its turn, and anyone listed by then fails it `confirmation_required`, with nothing sent. So no cancel
   reaches a tournament with registrants unless someone typed its display id. Like an edit, a cancel in flight at a
   crash is `unknown`, a 5xx is settled by one re-read and never resent by the job, and recovery leaves the planned row
   and staff alone until a retry finds out.

## Update (#95): required events as built

Building coverage (decision 12) settled what it left open:

1. **Country `US`.** Series windows are per country and the app keeps no league country, so coverage reads the `US`
   windows, the default the form options already use (Update #91). Planned rows resolve their series exactly as
   Upcoming does: the template organizer's series list and the venue's country.
2. **The grid shows the previous period too:** the previous, current and next two months for `month`, and the
   previous, current and next quarter for `quarter`. So a period in its last chance, or missed, stays on screen.
3. **Status comes from the listing's `application_state`** (else `status`). The port's `Tournament` carries it, and
   details are read only for the series, which a professor can't change, so their cache never goes stale. `sanctioned`
   or `complete` count, `approval-pending` is pending, `sanctioning-error` is a problem, cancelled, deleted and
   invalidated are ignored (as the application state or the status), and any other value is pending, never covered. A
   series the details give without a name is named from play-tools' series list; when that list can't be read, the
   tournament is unread, so its period is `unknown`.
4. **No connection or no league is `unknown` too.** With nobody connected, or no league selected, nothing can be
   confirmed, so no uncovered period shows `missing`.
5. **Any tournament job's end drops every cached listing**, not only its professor's. A listing read in flight then
   isn't cached, so a just-created tournament is never hidden behind a stale listing.
6. **The minimum count:** with `m` the minimum, a period is `sanctioned` with `m` sanctioned tournaments, else
   `covered (manual)` with a cover, else `pending` when sanctioned and pending reach `m`, else `planned` when planned ones
   bring it to `m`, else `problem` with any errored one, else `missing`.
7. **Planned rows count while they aren't in play-tools** (`planned`, `creating`, `failed`, `unknown`, no guid), from
   the creatable window on, by the league-`TZ` date of their start, after `unknown` rows are linked to what the listing
   shows. When their organizer's series can't be read, the template's own series match stands in; a row with a series
   pick can't be judged then, and its period is `unknown`, never `missing`.
8. **The listing cache is coverage's for now.** Upcoming keeps its live read; This week and Upcoming move onto it with
   their pages (#98, #99). Coverage names a failed listing `needs_reconnect`, `upstream_unavailable` (a 429 or 5xx) or
   `refused` (any other play-tools error). *As built (#98):* the cache is the tournaments module's own
   (`listing-cache.ts`), shared by coverage and Upcoming; Upcoming's `?refresh=1` lists again, and a tournament job's end
   still drops it all. The create-through preview, which decides what a job creates, keeps a live listing. *As built
   (#99):* This week reads its cards' status and planned rows through Upcoming for the date, so through the cache; its
   Staff read stays live, since it reads each tournament's participants anyway and staff decisions depend on that fresh
   read. Its required-events banner shares the nav badge's coverage read.
9. **Human-scale traffic.** Details reads run one at a time and stop at the first 429 or 5xx; the rest, and the
   linking of `unknown` rows, wait for the next request, their periods `unknown` meanwhile. A details failure a retry
   won't fix (refused, not found, an unexpected shape) isn't asked again until the listings are next read. Concurrent reads (the grid, the banner and the badge) share one
   listing and one details read per tournament. A league has at most 50 requirements.
10. **Tournaments without `start_date_v2`** can't be placed in a period and are left out, as Upcoming leaves them
    out. Only legacy tournaments lack it; a manual cover covers one if it ever matters.
11. **Requirements are never deleted**, only turned off, so the six are seeded once, when a league has no rows. A
    cadence change is refused while manual covers hold the old cadence's periods (`requirement_has_covers`).

## Update (#162): one-offs change any detail; Required events gets a tab

**Context.** The organizer (2026-10-15): "I should be able to create a custom tournament using a template … all of the
tournament's details should be overridable if desired", and "the tournaments page is way too cluttered. The required
events should be a separate module within the tournaments page." A one-off took only a template, a date and a time;
anything else took a second step through **Edit…** or a throwaway template. The grid of up to six requirements × their
periods pushed the tabs below the fold.

**Decision.**

1. **A one-off may change any template detail but the organizer and the game** (extends decision 4). `POST
   /planned-tournaments` takes `overrides` (name, format, venue, registration, contacts, details, website, each checked
   as the template checks it) and `seriesId` (`custom` or a play-tools series), stored as the row's overrides and series
   pick, the layer decision 11 already resolves. The organizer and the game stay the template's (organizer,
   2026-10-15): the address book, formats, series and coverage follow them, so another template is the way. The dialog
   sends only what differs from the template (a venue by its id, a blank text as none), so "templates are read at
   creation time" still holds for every detail left alone. A one-off with no contact is refused (`contact_required`).
2. **A series pick holds only for its game, date and country.** `resolveSeries` takes a picked series only among
   those play-tools offers for the template's game, the date and the resolved venue's country; anything else is
   `series_not_found`. Upcoming and coverage judge by the resolved venue's country, as creation does, so a one-off's
   own venue can't make them disagree.
3. **Creation re-checks what a browser or a later edit could get wrong.** An item with no contact fails
   `contact_required`, and one whose venue play-tools now gives another time zone or country fails `venue_not_found`
   (a `null` from play-tools is not a disagreement), both before any `POST`.
4. **Required events is a tab** (amends decisions 10 and 12). Tournaments has tabs **Upcoming** (default), **Required
   events** (`?tab=required`), **Templates** and **Schedules**. The grid shows only on its tab, which carries the nav
   badge's count. The other tabs show the compact banner above the tabs, as This week does; it can't be dismissed, is
   named "Required events alerts" (so the grid alone is the "Required events" region), and links to the tab, from This
   week too. All of them read the layout's one coverage fetch.

**Consequences.**

- (+) A one-off differing from its template is one dialog, and nothing reaches play-tools that the organizer didn't see.
- (+) Tournaments opens on Upcoming; anything at risk still shows above the tabs, so moving the grid hides nothing.
- (−) A Custom one-off planned on a premier template's slot (same template, date and time) takes that occurrence's
  place (Update #91), and covers no requirement; coverage then shows the period missing.
- (−) Edit…'s **Also clear these overrides** (opt-in, previewed) can clear a one-off's overrides of the fields it
  carries, as for any planned row. The name isn't carried unless ticked.

## Consequences

- (+) A regular tournament is set up once. After that it's a reminder and one click per batch of dates, with no
  four-step form.
- (+) Back-to-back events are one scaffold, created together.
- (+) No duplicate tournaments from the app on its own: every create is preceded by a fresh listing and adoption,
  and a create that may have landed is never resent automatically. It becomes `unknown`, is linked if it shows up,
  and is sent again only by **Retry create**, whose dialog warns that the earlier attempt may still land (#100).
- (+) An edit never wipes a field the app doesn't model: the body holds only the changed fields (#100, Update #90).
- (+) Nothing reaches play-tools without a click. Even "create through a date" lists every tournament it will make
  and creates nothing past that date, so a wrong template can't multiply on its own.
- (+) A regular tournament such as "3rd Tuesday monthly" is created for months ahead in one click.
- (+) Rescheduling keeps the tournament: its display id, registrations and staff survive the move.
- (+) Any field can be edited from the app, and a change to a regular event (a new venue, cost or contact) is made
  once for the whole schedule, with a before → after preview of every tournament it touches.
- (+) A missing League Cup or League Challenge, for any game, shows weeks ahead on the pages the organizer already
  uses, with a one-click fix, and stays visible until it's dealt with.
- (−) Coverage depends on seeing every tournament. One run by an unconnected professor needs **Mark as covered**,
  and a type play-tools renames needs the requirement's match updated. Both are flagged rather than silently missed.
- (−) Overrides add a layer (template → schedule overrides → row overrides) that creation must resolve. The planned
  tournament view shows which settings come from where.
- (+) Staff follow a tournament through a reschedule, so staff credits keep working.
- (−) A new module with nine tables (templates, scaffolds, scaffold slots, schedules, schedule overrides, planned
  tournaments, requirements, manual covers, result uploads), four new job kinds and a new item table
  (`submission_tournament_item`).
- (−) Adoption matches on start, product, format and name. A tournament edited in play-tools after creation (renamed
  or moved) is no longer matched, and the app would plan it again. Its `guid` is stored, so this only affects
  tournaments that were never linked.
- (−) An `unknown` create needs the organizer's attention: a click to retry, or nothing if it shows up on its own. A
  retry while the earlier attempt is still in flight can still make a duplicate; the dialog says so (#100).
- (−) Upstream gives no error codes on create, so a refusal shows play-tools' message and a correlation id, not
  advice.
- (−) The date wire format depends on a play-tools feature flag (S8). The adapter must handle both, and the live
  capture must say which one is used.
- (−) A premier event can only move within its series' window. Moving it further is a cancel and a new tournament,
  which loses its registrations.
- (−) A reschedule may send the tournament back for approval. That is upstream's call, and the dialog warns of it.
- (−) Creating tournaments is more exposure to the ToS risk (§11) than attendance. It stays organizer-initiated, one
  call at a time and paced. A year of a weekly event (52 creates, 5 s apart) is a few minutes of traffic.
- (−) Creating far ahead means a premier series for a later quarter may not be published yet. Those dates fail with
  `series_not_found` and are created later with another click.

## Open questions

| #  | Question | Status |
| -- | -------- | ------ |
| Q1 | Does a professor's `PATCH` of the date and other fields work, does it accept a partial body, and does it send the tournament back for approval? | **Answered (S8 part 2, 2026-10-13):** yes. A partial `PATCH` → 204 changes only the fields sent (the other 32 read back identical). Moving `start_date_v2` moves `start_date_actual` and the local `start_date` with it. The tournament stayed `sanctioned`, for a custom event edited after its start; a premier event, or an edit before the start, is not tried. Reschedule edits in place (decision 8). Removing means cancelling (organizer, 2026-10-12) |
| Q2 | Which tournament types are in scope: custom (friendly) events only, or premier series (League Challenge, League Cup, Prerelease) too? | **Answered (organizer, 2026-10-12):** both; premier series are in scope |
| Q3 | Should a tournament's default staff be part of the template? | **Answered (organizer, 2026-10-12):** no (decision 9) |
| Q4 | Is there any case for automatic creation (e.g. weekly locals), or always a click? | **Answered (organizer, 2026-10-12):** "create everything up to date X" on a schedule, one click (decision 5); no background creation |
| Q5 | Production date format (`start_date_v2` UTC or naive `start_date`), create's response and initial status, and server-side refusals | **Answered (S8 part 2, 2026-10-13):** `start_date_v2` in UTC. Create → 201 `{guid}`. A custom event starts `sanctioned` / `pending` with no approval step; a premier event is not tried. `activity_division_info` must not be null (400 `{"errors":{"activity_division_info":[…]}}`); send one empty entry per division. A 24 h back-dated start was accepted; larger back-dating, overlaps and quotas are not tried ([spikes.md](../spikes.md#part-2-live-capture-2026-10-13)) |
| Q6 | What league assistants (Enhanced / Specialist) may create and cancel, vs. the owner | **Answered (organizer, 2026-10-12): out of scope.** Connected accounts are assumed to have the right permissions. A refusal shows support details for Pokémon support (decision 7) |
| Q7 | Which events must the league hold? | **Answered (organizer, 2026-10-12):** a League Cup per quarter and a League Challenge per month, for each of TCG, GO and VGC (decision 12) |
| Q8 | Do League Challenge series windows run monthly or quarterly in play-tools, and do series windows always align with calendar quarters? | **Answered (S8 part 2, 2026-10-13):** League Challenge windows are **monthly** (2026-11-01 → 11-30 for TCG, VGC and GO). A TCG window 09-01 → 11-30 runs a calendar quarter, and a prerelease window runs about a week. Its answer no longer changes coverage periods, which always follow the requirement's cadence (#102); a series window only sets a period's latest date |
| Q9 | Should a missed or at-risk requirement also notify outside the app (email, push)? | **Open: organizer.** Designed as in-app only (banner, grid, badge) |
| Q10 | Is the 7-day lead a hard rule? | **Answered (organizer, 2026-10-12):** no. Tournaments not yet held should be sanctioned 7 days ahead, as a guideline: a short-notice warning to acknowledge, never a refusal (decision 6) |
| Q11 | When can a tournament be rescheduled? | **Answered (organizer, 2026-10-12):** from 3 days before its start to 90 days after (decision 8) |
| Q12 | May **Retry create** on an `unknown` tournament run at once, or only after a wait? | **Answered (organizer, 2026-10-13, #100):** at any time, with a warning that says when the earlier attempt was sent (decision 5) |
| Q13 | Should **Also clear these overrides** be on by default when the template is updated? | **Answered (organizer, 2026-10-13, #100):** off by default (decision 11) |
