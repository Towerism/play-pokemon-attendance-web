# ADR-0007: Assign staff to tournaments as desired state, applied by a reconcile job

- Status: Accepted (2026-10-12, as part of M8)
- Date: 2026-10-11 (updated with spike S6 the same day)
- Issue: [#41](https://github.com/Towerism/play-pokemon-attendance-web/issues/41)
- Amended by: [ADR-0009](0009-tournaments-as-their-organizer.md): tournaments are listed as every connected professor and acted on only as their organizer (#75)
- Amended by (proposed): [ADR-0010](0010-tournament-templates-and-lifecycle.md): creating, cancelling and rescheduling tournaments, and uploading their results ([ADR-0011](0011-tdf-results-upload.md)), move into scope (M9)

## Context

On the same weekly visit where attendance is taken, the organizer assigns one or
more staff members to the night's tournament in play-tools. There are sometimes
several tournaments on one date. That assignment is how staff earn points for
staffing the tournament. Each assignment needs a **player ID** and a **role**. Several
people can be assigned, with different roles or the same role. The organizer
wants to search a **staff list**: people who have staffed this league's tournaments
before. The first request said "entered through this app". The organizer later widened
that to include staff already on play-tools (decision 5).

The v1 architecture listed "staff" as a non-goal (§2), so this needs a decision
rather than a quiet addition.

The organizer's rules:

- The app must **never attempt** to assign a staff member to a tournament that already
  lists the same player id.
- A tournament's **organizer** holds the role `organizer` by default, and nothing can
  change it. Their player id may never be assigned as staff to that tournament.
- Staff already on play-tools **seed the staff list**. Their names must be editable
  afterwards, because the name in play-tools can be a person's dead name.

What spike S6 established ([spikes.md](../spikes.md#s6-staff-assignment-done-2026-10-11),
fixtures in `server/modules/pokemon/adapters/play-tools/__fixtures__/s6/`):

- **Tournaments are their own resource.** They live under `core/tournaments/{guid}` and
  `core/tournament/{guid}`, not under play sessions, and their records are separate.
- **Listing tournaments:**
  - `GET core/activities?type=tournament&role=organizer&sort_by=-start_date` lists only
    the tournaments the caller organizes, newest first, DRF-paged.
  - It **ignores date filters**, so the app pages and filters by date itself.
  - Times come from `start_date_v2`, which is true UTC. `start_date` is local wall-clock
    time stamped `Z` and must never be used.
- **Staff management is organizer-only.** Someone who only staffs a tournament gets 403
  on its staff list.
- **Everyone on a tournament:** `GET core/tournaments/{t}/records` with no filter returns
  players *and* staff (including the `organizer` record), DRF-paged.
- **The organizer** is `organizer.player_id` in `GET core/tournament/{t}`.
- **Assign:**
  - It is one `POST core/tournaments/{t}/records` per staffer, with body
    `{role, player: false, participant: {player_id}, origin: "manual"}`, and answers
    201 `{guid}`. There is no bulk call.
  - A refusal is 400 with codes under `errors.body["participant.player_id"]`:
    `cannot_duplicate_participant`, `missing_certification` (enforced per product),
    `player_id_must_be_claimed`, `below_age`, `disciplined`, `merged_player_id`, and
    others.
- **Remove** is `DELETE core/tournaments/{t}/records/{r}` with body
  `[{"legacy_alias": "<player_id>"}]`, answering 204.
- **Change role** is `PATCH …/records/{r}` with
  `[{"op":"replace","path":"/role","value":…}]`, answering 204.
- **Roles are a fixed list in play-tools' own code**, not an endpoint:
  - `judge` (Judge)
  - `headjudge` (Head Judge)
  - `scorekeeper` (Scorekeeper)
  - `administration` (Support Staff)
  - `translator` (Translator)

  `organizer` is fixed and never offered.
- **Edit window:**
  - The UI allows adding until 90 days after the tournament's start.
  - Past that, upstream answers **423 `cannot_modify_old_activity`** with no per-person
    detail.
  - The organizer's call: a tournament past its window is locked to *every* change.

## Decision

1. **Staff assignment is in scope** as goal G6. Other play-tools features
   (creating or running tournaments, reporting) remain non-goals.

2. **A new `staffing` module** (`server/modules/staffing/`) owns everything local about
   staff:
   - the per-date assignments the organizer wants;
   - their upstream state;
   - the staff-list search.

   It talks to `roster` only through `RosterService` (to make a staffer a known
   `PLAYER`), and to upstream only through `PlayToolsGateway`.

3. **Tournaments are their own upstream resource behind the port.** `PlayToolsGateway`
   gains the following methods (contract in architecture §4.3):
   - `listTournaments(range?)` pages `core/activities` newest first and stops
     once `start_date_v2` falls before the range. It keeps tournaments whose
     `start_date_v2` falls within the range, and drops `cancelled`, `deleted` and
     `invalidated` ones. It covers every activity group the account organizes in, since
     professors often staff at other stores' events (organizer, #45). Each tournament
     carries its `groupId`, so callers choose which groups to show.
   - `getTournament(ref)` returns details, including `organizerPlayerId`.
   - `listTournamentParticipants(ref)` returns every record, unfiltered, every page.
   - `assignStaff(ref, {playerId, role})`
   - `changeStaffRole(ref, recordId, role)`
   - `unassignStaff(ref, recordId, playerId)`

   - **The tournament reference** is the tournament `guid`, refused locally unless it
     matches `^[A-Za-z0-9-]{1,64}$`. A tournament's label is its `name` and
     `display_id`.
   - **Roles** are the S6 list, held as a constant in the adapter (`listStaffRoles`)
     and stored as text.
   - **Upstream shapes stay in the adapter.** Upstream payloads never cross the port.

4. **Assignments are desired state.** The organizer edits a list per date and
   tournament. Nothing goes upstream until they click **Assign staff in play-tools**.
   Applying is a job of `kind = 'staff'` on the submission rails, with the same pieces
   as undo and clear:
   - the per-league lease;
   - the event log and SSE;
   - crash recovery and shutdown;
   - retry that re-reads first;
   - History.

   The job runs plan → execute → reconcile:
   - **Plan:** read the tournament's details and **everyone it lists**, every record and
     every page.
     - `toAssign` = wanted assignments whose player id the tournament doesn't list at all.
     - A wanted player the tournament already lists as staff in the same role is
       `already_assigned`, and the job **adopts** that record: its `guid` is stored on the
       assignment, and from then on it counts as the app's own record (decision 12).
     - A wanted player the tournament lists in any other way (as a player, or as staff in
       another role) is `already_listed`. **Nothing is sent for them** (decision 8).
     - The tournament's organizer is `is_organizer`, and nothing is sent (decision 9).
     - `toRechange` = this app's own records (created or adopted) whose wanted role the
       organizer has changed. They are sent as `PATCH` (decision 12).
     - `toRemove` = staff records **this app created or adopted** whose assignment the
       organizer has since removed.
     - Staff assigned directly in play-tools are shown, and **never** changed or deleted
       (ADR-0004).
   - **Execute:**
     - One call at a time, at least `NUXT_STAFF_DELAY_MS` apart (default 1 s, never
       under 500 ms).
     - Removals go first, then role changes, then assigns.
     - The token is fetched again for each call.
   - **Reconcile:** re-read the records, then mark each item `assigned`,
     `already_assigned`, `already_listed`, `is_organizer`, `role_changed`, `removed`,
     `already_removed`, `ineligible`, `failed` or `skipped`. The record `guid` from the
     201 is written back to the assignment for later removal or role change.
     `assigned` and `already_assigned` also write a `STAFF_HISTORY` row (decision 5).

5. **The staff list is staffing history, seeded from play-tools.** It is not curated by
   hand. A staffer is anyone with a row in `STAFF_HISTORY`: one row per (tournament,
   player), with the role and date. Rows come from three places:
   - **Our own assignments:** an assignment that reached play-tools (`source = app`).
   - **Every read of a tournament's participants** (Staff card, plan, reconcile): each
     staff record found, `organizer` excluded, is recorded (`source = upstream`). Staff
     added directly in play-tools join the list the next time the app looks.
   - **A one-time import**, "Import staff from play-tools" in Settings (organizer's
     answer to Q4, 2026-10-11). It is a read-only job of `kind = 'staff_import'` on the
     same rails, so it gets the lease, progress, History and crash recovery.
     - It pages every tournament the account organizes (`core/activities`), leaves out
       those in leagues the account is no longer in (update #67), and reads each other
       one's records one read at a time. Reads are not paced (organizer,
       2026-10-12: reads don't need pacing); `NUXT_STAFF_DELAY_MS` paces only the staff
       job's writes.
     - It records every staffer it finds.
     - Re-running it is harmless (rows are unique), so it doubles as "refresh".

   Search ranks by most recent, then most often. Each result shows the last role used,
   so it can pre-fill the role. The organizer's own `organizer` records never count:
   organizing is not staffing. Staffing history is not attendance evidence (decision 6).

6. **Staff assignments are not sightings.** Following ADR-0005 and S4 design change 6,
   a staff role is not evidence of playing. Curation metrics are unchanged.

7. **Staffing is independent of attendance.** Staff go to the tournament and attendance
   goes to the play session, which are different resources with separate records (S6).
   Neither job reads or changes the other's records, and they can run in either order.
   The Submit dialog doesn't mention staff. They still share the per-league lease, so
   the app sends one job's calls at a time, keeping play-tools traffic human-scale.

8. **Never attempt to assign a player id the tournament already lists.** This is the
   organizer's rule, and it is absolute. Upstream's `cannot_duplicate_participant` is
   only a backstop, never the mechanism:
   - **Checked against upstream, not memory.** Immediately before each assign call, the
     job re-reads the tournament's records (unfiltered, every page). If the player id is
     now there in any role, it skips the call. Tournaments list few people and staff
     calls are one at a time, so the extra read is cheap. It closes the gap between plan
     and call, for example someone editing in play-tools.
   - **No blind retries.** After a 5xx or a timeout the call may have landed, so the
     job re-reads before deciding. If the player id is listed, the item is `assigned`
     (in our role) or `already_listed`, never sent again.
   - **If upstream still answers `cannot_duplicate_participant`**, someone added the
     person between the re-read and the call. The item becomes `already_listed` after a
     re-read, and the job never retries it.
   - **One player per tournament, locally too.** `STAFF_ASSIGNMENT` is unique on
     `(league_id, tournament_id, player_id)` while not removed. The add route refuses a
     second role for the same player with 409 `player_already_staffed`. Staff search
     shows players the tournament already lists as disabled, with how they are listed.
   - The ids are compared exactly as text, so leading zeros count.
   - The app never changes or deletes a record it neither created nor adopted (decision 4):
     only a `record_id` stored on one of the league's assignments is ever sent a `PATCH`
     or a `DELETE`.

9. **A tournament's organizer is never its staff.** The organizer's role is
   `organizer`, set by play-tools and fixed: the app never assigns, changes or removes
   it.
   - **Who the organizer is** comes from `organizer.player_id` in the tournament details
     (`getTournament`). Their `organizer` record in the listing is a second signal,
     already covered by decision 8. It is per tournament, so the organizer of one
     tournament may still staff another.
   - **Refused at entry:** adding the organizer's player id to that tournament's staff
     is 422 `organizer_cannot_staff`, checked against fresh details. If play-tools can't
     be reached, the add fails with the usual upstream error rather than skipping the
     check.
   - **Refused at apply:** the job checks again in the plan and before each call. An
     organizer row ends `is_organizer`, and nothing is sent.
   - **Not a role:** `organizer` is not in `listStaffRoles`. Submitting it is
     `unknown_role`. Staff search shows the organizer disabled, tagged "Organizer".

10. **Eligibility is upstream's call.** The app keeps no certification, age or
    discipline rules. A 400 on assign is that staffer's outcome, `ineligible`, carrying
    the upstream code and a readable reason, for example "not certified for this role
    at a VGC event" (`missing_certification`). The job carries on with the others.
    - **`merged_player_id`** names the id that should have been used. The app shows it
      as a suggestion and never switches ids on its own. The organizer edits the
      assignment.
    - **An unknown code** is still `ineligible`, with the raw code. Only a 400 with no
      readable `participant.player_id` errors is `failed`.

11. **Tournaments past their edit window are read-only.**
    - **Which tournaments can be edited.** A tournament is editable until 90 days after
      its start (`start_date_v2`). `listTournaments` marks it `editable: false` after
      that, and the UI shows its staff with no actions. Assignments for it are refused
      locally with `tournament_locked`.
    - **If upstream answers 423 `cannot_modify_old_activity`** to any call (an earlier
      cut-off than 90 days, or a clock difference), the job stops for that tournament:
      - the status is `failed`, with the reason `tournament_locked`;
      - unsent items are `skipped`;
      - the tournament is treated as locked from then on.

      Nothing is retried.
    - **403** means the connected account doesn't organize the tournament. It stops the
      job with `forbidden`. Only tournaments from `listTournaments` (organizer-only) are
      offered, so this means the account changed.

12. **The app may change the role of a record it created or adopted, and only that.** When
    the organizer edits the role of an applied assignment, the job sends `PATCH` on that
    record (`role_changed`). An adopted record is one play-tools already listed in the wanted
    role when a staff job first ran for that assignment (decision 4). The app never re-roles
    any other record found upstream, the organizer's record, or anyone listed as a player. If `PATCH` is refused, the item is `failed`,
    and the previous role stays both upstream and in the row.

13. **Names are the organizer's to correct. Play-tools names only seed.** A play-tools
    name can be a person's **dead name**:
    - **Seed only.** A staffer found upstream becomes a `PLAYER` through `RosterService`.
      Their play-tools name (`display_first_name display_last_name`) is used **only when
      the app has no name for them yet**. It never overwrites a name, at seeding or on
      any later read. This is the existing "first non-empty name sticks" rule, now relied
      on deliberately.
    - **Editable.** The organizer renames anyone with the existing `PATCH
      /players/{playerId}`, from the staff list (a Staff tab on Players) or anywhere a
      player is shown. A rename is final: no later import or read reverts it.
    - **The local name is what the app shows.** That covers the Staff card, staff search,
      History and the play-tools-only staff list on a tournament. A play-tools name is
      shown only for someone the app doesn't know yet, and seeding makes that the
      exception. Logs carry player ids, not names.
    - **Not kept:** the upstream name is not stored next to the local one, and the
      app never compares the two. Records also carry `year_of_birth`, which the adapter
      drops at the port, like TDF birthdates.

### Update (#47, 2026-10-12): adopted records count as the app's own

The organizer confirmed on #47 that an `already_assigned` match stores the upstream
record's `guid` on the assignment. Removing or re-roling that assignment later sends a
`DELETE` or `PATCH` naming that record, as for a record the app created. Decisions 4, 8
and 12 say so. Records no assignment holds (staff added in play-tools that nobody asked
the app for, the organizer's record, players) are still never changed or deleted.

### Update (#67, 2026-10-12): the import reads only the account's current leagues

The organizer's first import stopped at "Read 0 of 102". A spike on #67 found why:
`core/activities?role=organizer` still lists tournaments the account ran under leagues
it has since left, but play-tools refuses their records with 403
`op.activity_group.criteria_failure`. In the organizer's account, 37 of 117 tournaments
were in two former leagues, and every one was refused. All 80 in the current league
were readable. So the import now reads the account's leagues once (`listLeagues()`) and
leaves out any tournament whose activity group isn't one of them, without requesting it.
History's `planned` event counts what was left out. A tournament with no activity group
is still read. Any other 403 on one tournament is skipped (`tournament_failed`), while a
401 (the token refused) still stops the import. Decision 5 says so. Staff from former
leagues' tournaments can't be imported, because play-tools won't show them.

### Update (#76, 2026-10-12): assign staff for every tournament on a date at once

A date with several tournaments meant opening **Assign staff in play-tools** on each
card and waiting for each job, because a second one is refused while the first holds
the lease. Since #75 those tournaments can belong to different professors. The organizer
confirmed on #76:

- **A staff batch, run by the server.** `POST /sessions/{date}/staff/apply-all
  {tournamentIds}` (1 to 20, in the staff list's order) starts one **ordinary**
  `kind = 'staff'` job per tournament, one after another. Each job has the same plan,
  rules, pacing, retries, events, reconcile, History entry and retry as a single apply,
  and each runs and is recorded as its tournament's organizer (ADR-0009). Before each
  job, the same fresh checks as a single apply run (`prepareApply`). A tournament they
  refuse is recorded as **not started** with the refusal's code, and the batch goes on.
  A job that ends `failed` or `partial` doesn't stop the batch either.
- **One hold of the lease.** The batch takes the per-league lease when it starts and
  hands it to each job and back without freeing it. Between jobs, `submission_lock.
  submission_id` holds minus the batch id. No job of any kind starts in between, and the
  app still sends one call at a time (decision 7). Staff writes stay at least
  `NUXT_STAFF_DELAY_MS` apart per league, including the last write of one tournament
  and the first write of the next.
- **Why the server sequences it**, not the browser: the batch keeps going if the page
  is closed. It also avoids the gap where the lease is freed just after a job's
  `finished` event, when a browser starting the next job could be refused.
- **Following it.** `GET /staff-batches/{id}` shows one row per tournament: waiting,
  running (with progress), succeeded, partial, failed, not started (with why) or
  interrupted. `GET /sessions/{date}/staff/apply-all` returns the date's running batch
  (204 if none), so a reloaded page can show it again. The batch is `succeeded` when
  every job succeeded, `failed` when none got anywhere, and `partial` otherwise.
  **Retry failed** starts a new batch of the tournaments that didn't succeed, and each
  job re-reads first (ADR-0004). The batch itself has no History entry; its jobs do.
- **Recovery.** On shutdown the batch starts no further tournament. Boot recovery marks
  a batch left running `interrupted`, along with its waiting tournaments.
- **Tables.** `staff_batch` (league, date, who started it, status) and
  `staff_batch_item` (position, tournament, status, its job, refusal), owned by the
  submission module.

There is no cancel, and nothing runs in parallel, even for different professors.

## Alternatives considered

- **Fire each assignment immediately, synchronously.** Simpler UI, but it skips the
  plan and the re-read that decision 8 needs. It would also leave no History, and
  calls would not be serialized with the league's other jobs. Rejected.
- **A separate staffing job runner.** That would duplicate the lease, SSE, crash
  recovery and shutdown handling that undo and clear already reuse. Rejected.
- **Fold staff into the attendance submission (one job).** The two target different
  upstream resources, and the organizer runs them at different moments. Rejected.
- **Treat a tournament as the date's play session.** S6 shows they are separate
  resources with separate records. Rejected.
- **Let upstream's duplicate rule catch it** (send, then map
  `cannot_duplicate_participant`). Rejected: the organizer's rule is that the app must
  never *attempt* such an assignment. The code is kept only as a backstop.
- **Use upstream's date filter on `core/activities`.** S6 showed it is ignored. Paging
  newest-first and stopping early costs one or two pages for a current date.
- **Role change as remove and re-add.** That would briefly take the staffer off the
  tournament, and the re-add could be refused (for example after the window closed).
  `PATCH` is atomic upstream. Rejected.
- **Mirror certification rules locally.** They are per product and maintained by
  play-tools. Duplicating them would drift. Rejected.
- **A staff list from the app's own assignments only.** This was the first draft. The
  organizer wants everyone who has staffed their tournaments, including staff entered
  in play-tools before this app existed. Rejected.
- **Keep the play-tools name next to the local one** (for example, to flag a
  difference). This would store a possible dead name for no benefit, and invite showing
  it. Rejected.
- **A curated staff list (like Regulars).** This is more to maintain, and the request
  defines the list by history ("people who have staffed our tournaments before"). It
  can be added later as a `pinned` flag if needed.

## Consequences

- (+) Re-applying is safe: the plan only sends what upstream is missing, so a retry
  never double-assigns.
- (+) The app never sends an assignment for a player id the tournament already lists,
  or for its organizer. The guarantee rests on a fresh read, not on upstream refusing
  the call.
- (+) Removal and role changes are explicit and limited to records this app created or
  adopted for an assignment the organizer made, so ADR-0004's "never auto-delete upstream
  records" holds.
- (+) History becomes the audit trail for staffing, which is the evidence staff need
  if points go missing.
- (+) Staffing and attendance don't constrain each other's order.
- (+) The staff list is complete from day one (the import), and it stays current
  without effort (every read seeds it).
- (+) A corrected name sticks everywhere and is never reverted by play-tools data.
- (+) Eligibility stays upstream's, so a certification change in play-tools needs no
  app release.
- (−) The adapter must page `core/activities` itself and never touch `start_date`. Both
  are covered by fixtures 04, 14 and 19.
- (−) Each apply makes several reads: details, plus a records re-read before every
  assign. That is fine at single-digit staff counts.
- (−) `submission` grows another `kind`, and `submission_item` grows a nullable
  `role` column.
- (−) The import reads every tournament the league has run (117 at S6), one read a
  second, so it takes a few minutes. It runs once, on demand, and is resumable.
- (−) A staffer seeded with a dead name shows it until the organizer renames them. The
  Staff tab makes that easy to find, and the import's result lists who was added.
- (−) The roles live in the adapter. If play-tools adds a role, the app needs a
  release.

## Open questions

| #  | Question                                                                | Status                                                                                  |
| -- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Q1 | Which calls do the tournament list and its staff section make?          | **Answered by S6** (see Context)                                                        |
| Q2 | Is a tournament the weekly play session or a separate resource?         | **Answered:** separate (organizer, then S6 at the API)                                  |
| Q3 | Which roles does play-tools offer?                                      | **Answered by S6:** judge, headjudge, scorekeeper, administration, translator             |
| Q4 | Should staff already on play-tools seed the staff list?                 | **Answered by the organizer:** yes, with names editable after seeding (decisions 5 and 13) |
| Q5 | How does a date map to its tournaments?                                 | **Answered by S6:** `start_date_v2` within the league-`TZ` day, filtered by the app     |
| Q6 | The exact edit-window cut-off; whether `PATCH`/`DELETE` are locked too  | **Low risk.** Assumed start + 90 d and locked to every change (organizer); 423 handled either way |
| Q7 | Does `DELETE` work without the `legacy_alias` body?                     | **Moot:** the app always sends it, as play-tools does                                   |
