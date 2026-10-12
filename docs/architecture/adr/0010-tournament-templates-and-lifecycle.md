# ADR-0010: Tournament templates, schedules and lifecycle (create, cancel, reschedule)

- Status: Proposed (M9)
- Date: 2026-10-12
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
- **submitting the TDF** after the event, on This week, in the same card as staff (ADR-0011).

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

## Decision

Option 3.

### 1. Scope

Tournament creation, cancellation and rescheduling move into scope as **G7** (M9). Templates, scaffolds and
schedules are the app's own. Still out of scope: running a tournament (TOM does that), editing a created tournament's
other fields (done in play-tools), per-division registration times and costs, admin actions (delete, un-cancel,
approve), and roster-only uploads.

### 2. A new `tournaments` module

`server/modules/tournaments/` owns templates, scaffolds, schedules, planned tournaments and TDF result uploads
(ADR-0011). It reaches upstream only through `PlayToolsGateway`, uses `staffing` only through `StaffingService`
(decision 9), and connections only through `PokemonConnectionService`. Its jobs run on the submission rails
(decision 7). `staffing` stays as it is.

### 3. Vocabulary

- **Template:** one tournament's settings. It holds:
  - name (≤ 80, with optional `{month}`, `{year}` and `{date}` tokens filled from the tournament's date);
  - the **organizer**: one connected professor, who it is created as (ADR-0009);
  - product and format (`category`, from `core/products` for the venue's country);
  - **event type**: `custom`, or `premier` with a **series match** (text the series name must contain, e.g. "League
    Challenge"). The series itself is resolved per date (decision 6);
  - venue (an address-book entry of the organizer: id, label and timezone are kept);
  - the usual start time (local to the venue);
  - registration: `on_site` (opens N minutes before the start, closes M minutes after, admission text) or
    `third_party` (a URL);
  - contact email and/or phone, details, event website;
  - **default staff**: `[{playerId, role}]`, roles from `listStaffRoles` (decision 9).

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

- **Materialised on read.** Reading the upcoming tournaments upserts each active schedule's occurrences inside its
  horizon (unique on schedule, slot and date), so there is no scheduled task to keep in step and nothing depends on
  the server having been up.
- **Editing a schedule or scaffold** replans only what hasn't reached play-tools: `planned` and `skipped` rows that
  no longer fit are deleted, new ones added. **A created tournament is never cancelled, moved or recreated because
  a schedule changed.** It is shown as "no longer in the schedule", with Cancel and Reschedule offered.
- **Skipping** a date (a holiday) is local: the row becomes `skipped` and is never created.
- **Templates are read at creation time.** A planned tournament takes the template's settings when it is created, so
  editing a template changes every tournament not created yet, and none that exist.
- **Reminders, not automation.** This week shows "N planned tournaments in the next 2 weeks aren't in play-tools
  yet", with a button to create them.

### 5. Creating: a `tournament_create` job

**Create in play-tools** takes 1–20 planned tournaments and starts one job of `kind = 'tournament_create'` on the
submission rails. Each is created as its template's organizer. A planned tournament whose organizer can't act is not
started (`organizer_not_connected`, `needs_reconnect`), as for staff.

- **Plan.** For each planned tournament, as its organizer:
  - list their tournaments on that date in the league's activity group (`listTournaments`);
  - **adopt instead of create:** a live (not `cancelled`, `deleted` or `invalidated`) tournament with the same start
    instant, product, format and name (compared case-insensitively) is that planned tournament. Its `guid` is
    stored and the item is `already_exists`. Nothing is sent. This is how a retry, a crash or a tournament the
    organizer made in play-tools by hand never produces a second one;
  - resolve the series and venue (decision 6). Anything unresolved fails that item before any call.
- **Execute.** One `POST core/tournament` at a time, at least `NUXT_TOURNAMENT_DELAY_MS` apart (default 5 s, never
  under 2 s). The token is fetched for each call.
  - **A 5xx or a timeout means "may have landed"** (as for `_bulk`, ADR-0004 update). The job re-lists for a settle
    window (default 3 min) and adopts a match. It sends again only when the settle window ends with no match, and
    at most once.
  - **A 4xx is that item's outcome**, `refused`, with upstream's message and the correlation id (S8 found no codes).
    The job goes on with the rest. A 401 or 403 stops the job (`forbidden`).
- **Reconcile.** Re-read each created tournament (`getTournament`) and store its `guid`, `display_id` and status.
  `approval-pending` and `sanctioning-error` are shown as they are; the app doesn't chase approval.
  Default staff are added (decision 9).
- **Outcomes:** `created`, `already_exists`, `refused`, `failed`, `skipped`.

### 6. Series and venue are resolved, not stored

- **Series.** For a `premier` template, the series is the one from `listSeries` (as the organizer, for the league)
  whose product matches, whose name contains the series match, and whose window for the venue's country contains the
  date. None is `series_not_found`, and several are `series_ambiguous`, and the organizer picks one on the planned
  tournament (a stored override). A `quarterly` schedule therefore follows the new series each quarter with no edit.
- **Venue.** The template keeps the address-book id. A venue no longer in the organizer's address book is
  `venue_not_found`, and the organizer picks another on the template.
- **Dates.** The app doesn't mirror upstream's date rules (series windows, cycle end, back-dating). Like eligibility
  for staff (ADR-0007 decision 10), they are upstream's call. The planner shows the series window it found, and
  refuses only a date more than 72 h in the past.

### 7. Same rails as every other job

Creation, cancellation, reschedule and TDF confirmation are `submission` rows with new kinds (`tournament_create`,
`tournament_cancel`, `tournament_reschedule`, `tdf_upload`). They get the per-league lease (one job of any kind at a
time, so play-tools sees one call at a time), the event log and SSE, History, retry that re-reads first, boot recovery
and shutdown. Their per-tournament items go in a new `submission_tournament_item` table, because `submission_item`
is per player.

### 8. Cancelling and rescheduling are explicit, and never automatic

**Cancel** (`kind = 'tournament_cancel'`, one tournament):

- **Offered** for any tournament of the league a connected professor organizes, made here or in play-tools, while
  upstream allows it (S8: `sanctioned`, `approval-pending` or `sanctioning-error`; not completed; within start + 90 d).
- **Confirm dialog** from a fresh read. It names the tournament, its date and display id, and how many players and
  staff it lists. When anyone is registered, the organizer types the display id, as Clear session asks for the date.
- **As the organizer.** It sends `PATCH core/tournament/{guid}/ {application_state: "cancelled"}`, then re-reads.
  An already cancelled tournament is `already_cancelled`, and nothing is sent.
- **Afterwards.** The planned tournament becomes `cancelled`. Its staff assignments that never reached play-tools
  are dropped, and the rest are marked removed locally. Nothing more is sent.

**Reschedule** (`kind = 'tournament_reschedule'`, one tournament, a new date and start time) **edits the date in
place** (organizer, 2026-10-12: use the `PATCH` when play-tools allows it):

- **One call, as the organizer.** The job reads the tournament fresh (`getTournament`), then sends `PATCH
  core/tournament/{guid}/` with the new start. The registration window moves by the same amount, so its offsets from
  the start are kept. The body is the create body built from that fresh read with only the dates changed, as
  play-tools' edit form does, unless the live capture shows a partial body is accepted (Q1).
- **Same tournament.** The `guid`, display id, registrations and staff stay. The planned tournament and its wanted
  staff assignments move to the new date locally. No staff call is needed.
- **Refused locally** before any call, from the fresh read:
  - past start + 90 days (`tournament_locked`), or not in a state play-tools lets a professor edit;
  - for a premier event, a new date outside its series' window for the venue's country (`outside_series_window`).
    A professor can't change the series, so moving a League Cup into another quarter means cancelling it and making
    a new one, which the dialog says;
  - more than 72 h in the past.
- **Re-read, never re-send blindly.** A tournament already at the new start is `already_rescheduled`, and nothing is
  sent. After a 5xx the job re-reads, and the edit counts as landed when the start matches.
- **Status afterwards.** If play-tools moves the tournament back to `approval-pending` (or `sanctioning-error`), the
  outcome says so, and the card shows it. The confirm dialog warns that play-tools may re-check the tournament.
- **Fallback, only if the live capture shows a professor can't change the date:** cancel, then create on the new date
  with the same settings, in one job, cancel first. It would track `replacing` / `recreate_pending` so a stopped job
  is visible and resumable, and move the wanted staff to the new tournament as `pending`. That would need this ADR
  updated and the organizer's approval before it is built.
- **A schedule never reschedules.** A planned tournament that hasn't reached play-tools is just edited (date, time).

### 9. Default staff become wanted staff

When a tournament is created (or adopted) for a planned tournament whose template has default staff, the job adds them
as **pending** staff assignments through `StaffingService`, for that tournament and date. ADR-0007 applies unchanged:
nothing is sent until **Assign staff in play-tools**, the organizer is never staffed, and anyone already listed is
skipped. A staffer refused at that point (for example, the template's organizer) is reported in the job's result, and
creation still counts as done.

### 10. Where the organizer does it

- **A new Tournaments page** (`tournaments.vue`, in the nav), with three tabs:
  - **Upcoming:** planned and upstream tournaments for the coming weeks, by date. Each shows its status (planned,
    skipped, in play-tools, approval pending, sanctioning error, cancelled) and offers
    **Create in play-tools** (one, or every selected), **Skip**, **Reschedule…** and **Cancel…**. A one-off
    **New tournament** comes from a template and a date.
  - **Templates:** list, create, edit, archive. The form's choices (formats, series, venues) are read live from
    play-tools as the template's organizer.
  - **Schedules:** scaffolds (slots: template, day offset, start time) and their recurrence, with a preview of the
    next dates before saving.
- **This week** turns each Staff card into a **tournament card**: its status, its Staff section (as built), and a
  Results section for the TDF (ADR-0011). A date with planned tournaments not yet created shows them, with
  **Create in play-tools**. Cancel and Reschedule stay on the Tournaments page, away from the weekly flow.

## Consequences

- (+) A regular tournament is set up once. After that it's a reminder and one click per batch of dates, with no
  four-step form.
- (+) Back-to-back events are one scaffold, created together.
- (+) No duplicate tournaments: every create is preceded by a fresh listing and adoption, and a 5xx is re-read before
  any resend.
- (+) Nothing reaches play-tools without a click, so a wrong template can't multiply on its own.
- (+) Rescheduling keeps the tournament: its display id, registrations and staff survive the move.
- (+) Staff follow a tournament from its template and through a reschedule, so staff credits keep working.
- (−) A new module with five tables (templates, scaffold slots, schedules, planned tournaments, result uploads), four
  new job kinds and a new item table.
- (−) Adoption matches on start, product, format and name. A tournament edited in play-tools after creation (renamed
  or moved) is no longer matched, and the app would plan it again. Its `guid` is stored, so this only affects
  tournaments that were never linked.
- (−) Upstream gives no error codes on create, so a refusal shows play-tools' message and a correlation id, not
  advice.
- (−) The date wire format depends on a play-tools feature flag (S8). The adapter must handle both, and the live
  capture must say which one is used.
- (−) A premier event can only move within its series' window. Moving it further is a cancel and a new tournament,
  which loses its registrations.
- (−) A reschedule may send the tournament back for approval. That is upstream's call, and the dialog warns of it.
- (−) Creating tournaments is more exposure to the ToS risk (§11) than attendance. It stays organizer-initiated, one
  call at a time, paced.

## Open questions

| #  | Question | Status |
| -- | -------- | ------ |
| Q1 | Does a professor's `PATCH` of the date work, does it accept a partial body, and does it send the tournament back for approval? | **Open: S8 part 2.** Removing means cancelling (organizer, 2026-10-12); reschedule edits in place if the `PATCH` works, else the fallback in decision 8 |
| Q2 | Which tournament types are in scope: custom (friendly) events only, or premier series (League Challenge, League Cup, Prerelease) too? | **Open: organizer.** Designed for both |
| Q3 | Should a tournament's default staff be part of the template? | **Open: organizer.** Designed in (decision 9) |
| Q4 | Is there any case for automatic creation (e.g. weekly locals), or always a click? | **Open: organizer.** Designed as always a click |
| Q5 | Production date format (`start_date_v2` UTC or naive `start_date`), create's response and initial status, and server-side refusals | **Open: S8 part 2** |
| Q6 | What league assistants (Enhanced / Specialist) may create and cancel, vs. the owner | **Open: S8 part 2** |
