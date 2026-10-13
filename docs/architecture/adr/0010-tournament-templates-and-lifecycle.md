# ADR-0010: Tournament templates, schedules and lifecycle (create, cancel, reschedule)

- Status: Accepted (2026-10-12, M9)
- Date: 2026-10-12
- Updated: 2026-10-13 ([#100](https://github.com/Towerism/play-pokemon-attendance-web/issues/100), from the PR #83 review;
  accepted by the organizer when its PR merges): an uncertain create is never resent automatically (`unknown`); edits
  pass every field they don't change through from the raw read; adoption skips tournaments already linked; rows a job
  holds are `creating`; the back-dating window is checked at send time; template updates name the overrides that
  shadow them. See [Update (#100)](#update-100-no-duplicate-creates-no-wiped-fields).
- Amends: architecture §2 (tournament creation was a non-goal), [ADR-0007](0007-staff-assignment.md) decision 1
- Builds on: [ADR-0004](0004-idempotent-diff-based-submission.md) (plan → execute → reconcile),
  [ADR-0009](0009-tournaments-as-their-organizer.md) (act on a tournament only as its organizer)
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
  accepted (Q1).
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
    date), **Cancel…** and **Download TDF**. A one-off
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
- **The full body is the raw read, not the create body** (#100). The app doesn't model every field: per-division
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
    its series' formats), `venue_not_found`, `edit_body_unmappable` (above).
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
- **Periods.** A period is the matching series' own window from `listSeries`, for the venue's country, when play-tools
  has one (League Cup series run "October - December"). Otherwise it is the calendar month or quarter in the league
  `TZ`. Coverage looks at the current period and what follows: the next 3 months, and the current and next quarter.
- **What counts.** A tournament covers a requirement's period when its product matches, its series matches, and its
  start falls in the period. Tournaments are taken:
  - from play-tools: every connected professor's tournaments in the league's activity group (ADR-0009), with each
    tournament's series from its details. The details are read once per tournament and cached by `guid`, since a
    professor can't change a series;
  - from the app: planned tournaments not yet created, whose template and date resolve to a matching series.
- **Status of each requirement in each period,** best first:
  - `sanctioned`: a live tournament is sanctioned (or already complete);
  - `pending`: the best is `approval-pending`;
  - `planned`: only a planned tournament in the app, not yet in play-tools;
  - `problem`: the only match is `sanctioning-error`, which doesn't count;
  - `missing`: nothing.

  Cancelled, deleted and invalidated tournaments never count.
- **Urgency**, worked out from today in the league `TZ`, getting louder:
  - **open:** the period has started or is ahead, and it isn't covered yet;
  - **at risk:** it isn't `sanctioned` and the period ends within the warning lead (default 21 days for monthly, 45
    for quarterly, editable per requirement). `planned`, `pending` and `problem` are at risk too: a planned tournament
    isn't in play-tools, and approval can be refused. The cell names the **sanction-by date** for a tournament on the
    period's last day (its end − 7 days);
  - **short notice:** that sanction-by date has passed and it still isn't covered. A tournament can still be
    sanctioned before the period ends, with the short-notice warning (decision 6). The banner says so and gives the
    latest dates left;
  - **last chance:** the period has ended less than 2 days ago and isn't covered. A tournament held in its last 2 days
    can still be sanctioned (decision 6), and the warning says which dates qualify;
  - **missed:** the period ended more than 2 days ago uncovered. It stays on record and in the grid's history.
- **Impossible to overlook:**
  - a **Required events** grid at the top of the Tournaments page: requirements × periods, each cell showing its
    status, the covering tournament (display id, date, organizer), or the action to take;
  - on **This week**, a banner whenever anything is **at risk**, **short notice**, **last chance** or **missed** (one line per
    requirement and period, most urgent first), and **problem** whenever a tournament comes back `sanctioning-error`;
  - a count badge on the Tournaments nav link while anything is at risk or worse.

  The banner can't be dismissed. It goes away only when the cause does.
- **One click to fix.** A cell that isn't covered offers **Plan one…**: a one-off **New tournament** with the type
  and game set, and a date inside the period. It uses a template that matches if there is one, and otherwise opens the
  form with play-tools' choices for that date. A `planned` cell offers **Create in play-tools**, and a `problem` cell
  links the tournament in play-tools.
- **Covered somewhere the app can't see.** play-tools lists only the tournaments a connected professor organizes (S6).
  A Cup run by another professor of the league whose account isn't connected would show as missing. **Mark as
  covered…** records a manual cover for that requirement and period, with a note (e.g. "run by Professor X, 0123-…"),
  who and when. It shows as `covered (manual)`, never as `sanctioned`, and can be removed. Connecting that professor
  (ADR-0008) makes it automatic.
- **Pure and testable.** Coverage is a pure function in `shared/requirements/`: requirements, periods, tournaments and
  manual covers, plus today, in; statuses and urgencies out, with no clock and no I/O. It is unit-tested across period
  edges, DST, the 2-day grace, series windows that differ from calendar quarters, and cancelled or errored
  tournaments.
- **Read on demand.** The grid and the banner are computed when the page is read, from the same per-professor
  listings the Upcoming tab and This week already make. Nothing is scheduled, and no notification leaves the app
  (email or push would be a later decision).

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
- **Contract:** against a recorded S8 part 2 read with every field set, only the changed fields differ in the edit
  body, and an unmapped field is refused before any request.
- **Determinism:** every time-dependent case uses an injected clock, never a wall-clock wait: the settle window, the
  late landing, midnight, the DST days in `America/Chicago`, and "how long ago".
- **Behaviour over mocks:** assertions read the fake's request log and the database, never mock call counts.
- **Coverage, by risk:** 100% branch coverage on the matcher, the edit-body merge and the window check, and at least
  90% on the job state machine and override resolution.

## Consequences

- (+) A regular tournament is set up once. After that it's a reminder and one click per batch of dates, with no
  four-step form.
- (+) Back-to-back events are one scaffold, created together.
- (+) No duplicate tournaments from the app on its own: every create is preceded by a fresh listing and adoption,
  and a create that may have landed is never resent automatically. It becomes `unknown`, is linked if it shows up,
  and is sent again only by **Retry create**, whose dialog warns that the earlier attempt may still land (#100).
- (+) An edit never wipes a field the app doesn't model: the body is the raw read with only the changed fields
  replaced, and an unmappable field refuses the edit (#100).
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
- (−) An edit of a tournament whose read has a field the adapter can't map is refused until the adapter learns it.
  That is safer than wiping the field (#100).
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
| Q1 | Does a professor's `PATCH` of the date and other fields work, does it accept a partial body, and does it send the tournament back for approval? | **Open: S8 part 2.** Removing means cancelling (organizer, 2026-10-12); reschedule edits in place if the `PATCH` works, else the fallback in decision 8 |
| Q2 | Which tournament types are in scope: custom (friendly) events only, or premier series (League Challenge, League Cup, Prerelease) too? | **Answered (organizer, 2026-10-12):** both; premier series are in scope |
| Q3 | Should a tournament's default staff be part of the template? | **Answered (organizer, 2026-10-12):** no (decision 9) |
| Q4 | Is there any case for automatic creation (e.g. weekly locals), or always a click? | **Answered (organizer, 2026-10-12):** "create everything up to date X" on a schedule, one click (decision 5); no background creation |
| Q5 | Production date format (`start_date_v2` UTC or naive `start_date`), create's response and initial status, and server-side refusals | **Open: S8 part 2** |
| Q6 | What league assistants (Enhanced / Specialist) may create and cancel, vs. the owner | **Answered (organizer, 2026-10-12): out of scope.** Connected accounts are assumed to have the right permissions. A refusal shows support details for Pokémon support (decision 7) |
| Q7 | Which events must the league hold? | **Answered (organizer, 2026-10-12):** a League Cup per quarter and a League Challenge per month, for each of TCG, GO and VGC (decision 12) |
| Q8 | Do League Challenge series windows run monthly or quarterly in play-tools, and do series windows always align with calendar quarters? | **Open: S8 part 2** (`listSeries`). Coverage uses the series window when one exists, else the calendar period |
| Q9 | Should a missed or at-risk requirement also notify outside the app (email, push)? | **Open: organizer.** Designed as in-app only (banner, grid, badge) |
| Q10 | Is the 7-day lead a hard rule? | **Answered (organizer, 2026-10-12):** no. Tournaments not yet held should be sanctioned 7 days ahead, as a guideline: a short-notice warning to acknowledge, never a refusal (decision 6) |
| Q11 | When can a tournament be rescheduled? | **Answered (organizer, 2026-10-12):** from 3 days before its start to 90 days after (decision 8) |
| Q12 | May **Retry create** on an `unknown` tournament run at once, or only after a wait? | **Answered (organizer, 2026-10-13, #100):** at any time, with a warning that says when the earlier attempt was sent (decision 5) |
| Q13 | Should **Also clear these overrides** be on by default when the template is updated? | **Answered (organizer, 2026-10-13, #100):** off by default (decision 11) |
