# ADR-0007: Assign staff to tournaments as desired state, applied by a reconcile job

- Status: Proposed
- Date: 2026-10-11
- Issue: [#41](https://github.com/Towerism/play-pokemon-attendance-web/issues/41)

## Context

On the same weekly visit where attendance is taken, the organizer assigns one or
more staff members to the night's tournament in play-tools. There are sometimes
several tournaments on one date. That assignment is how staff earn points for
staffing the tournament. Each assignment needs a **player ID** and a **role**. Several
people can be assigned, with different roles or the same role. The organizer
wants to search a **staff list**: people who have staffed this league's tournaments
before and were entered through this app.

The v1 architecture listed "staff" as a non-goal (§2), so this needs a decision
rather than a quiet addition.

What we know:

- **Tournaments are a separate resource from play sessions** in play-tools, at least
  in its UI (the organizer, 2026-10-11). A tournament has its own page, and staff are
  assigned in a section of it. So the weekly play session that attendance goes into
  is not where staff go.
- The organizer's rules:
  - The app must **never attempt** to assign a staff member to a tournament that
    already lists the same player id.
  - A tournament's **organizer** holds the role `organizer` by default, and nothing can
    change it. Their player id may never be assigned as staff to that tournament.
- From spikes S3/S4 ([spikes.md](../spikes.md)), for play sessions only: records carry
  a `role`, the creator holds a hidden `role: "organizer"` record, and a second record
  for the same participant is refused. Whether any of this carries over to tournaments
  is unknown.

What we don't know yet is the subject of **spike S6**:

- how play-tools lists a league's tournaments, and how to find a date's tournaments;
- the calls the tournament page's staff section makes (list, assign, remove);
- how a tournament lists everyone on it (players and staff) and names its organizer;
- the role list;
- when a tournament stops accepting staff changes.

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
   gains:
   - `listTournaments` (a date's tournaments, from the tournament resource, not play
     sessions);
   - `listStaffRoles` (never includes `organizer`);
   - `listTournamentParticipants` (everyone the tournament lists, players and staff);
   - `assignStaff`;
   - `unassignStaff`.

   They take an opaque `TournamentRef`, stored as text. Paths, payloads, the role
   source and paging are S6's to record, and only the adapter, its fixtures and the
   fake change when they are. Roles are stored as text.

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
   - **Plan:** read **everyone the tournament lists**, every role, players and staff
     alike.
     - `toAssign` = wanted assignments whose player id the tournament doesn't list
       at all.
     - A wanted player the tournament already lists as staff in the same role is
       `already_assigned`, and the job adopts that record.
     - A wanted player the tournament lists in any other way (as a player, or as staff
       in another role) is `already_listed`. **Nothing is sent for them** (decision 8).
     - The tournament's organizer is `is_organizer`, and nothing is sent (decision 9).
     - `toRemove` = staff records **this app created** whose assignment the organizer
       has since removed.
     - Staff assigned directly in play-tools are shown, and **never** deleted
       (ADR-0004).
   - **Execute:** one call at a time, at least `NUXT_STAFF_DELAY_MS` apart (default
     1 s, never under 500 ms). There is no bulk call: staff counts are in the single
     digits.
   - **Reconcile:** re-read upstream, then mark each item `assigned`,
     `already_assigned`, `already_listed`, `is_organizer`, `removed` or `failed`.
     Record ids are written back to the assignment for later removal.

5. **The staff list is derived from the app's own assignments**, not curated. A staffer
   is any player with at least one assignment entered through this app that reached
   play-tools. Search ranks by most recent, then most often. Each result shows the
   last role used, so it can pre-fill the role. No new list needs maintaining, and
   it matches the request word for word. Staff found only upstream are not added
   (but see open question Q4).

6. **Staff assignments are not sightings.** Following ADR-0005 and S4 design change 6,
   a staff role is not evidence of playing. Curation metrics are unchanged.

7. **Staffing is independent of attendance.** Staff go to the tournament and attendance
   goes to the play session, which are different resources. Neither job reads or
   changes the other's records, and they can run in either order. The Submit dialog
   doesn't mention staff. They still share the per-league lease, so the app sends one
   job's calls at a time, keeping play-tools traffic human-scale. If S6 shows that
   tournaments and play sessions share participant records after all, this decision
   is revisited before M8 is built.

8. **Never attempt to assign a player id the tournament already lists.** This is the
   organizer's rule, and it is absolute. It doesn't depend on whether play-tools would
   refuse the call:
   - **Checked against upstream, not memory.** Immediately before each assign call, the
     job re-reads the tournament's participants (every page). If the player id is now
     there in any role, it skips the call. Tournaments list few people and staff calls
     are one at a time, so the extra read is cheap. It closes the gap between plan and
     call, for example someone editing in play-tools.
   - **No blind retries.** After a 5xx or a timeout the call may have landed, so the
     job re-reads before deciding. If the player id is listed, the item is `assigned`
     (with our role) or `already_listed`, never sent again.
   - **One player per tournament, locally too.** `STAFF_ASSIGNMENT` is unique on
     `(league_id, tournament_ref, player_id)` while not removed. The add route refuses
     a second role for the same player with 409 `player_already_staffed`. Staff search
     shows players the tournament already lists as disabled, with how they are listed.
   - The ids are compared exactly as text, so leading zeros count.
   - The app never changes the role of a record it finds, and never deletes and
     re-adds one.

9. **A tournament's organizer is never its staff.** The organizer's role is
   `organizer`, set by play-tools and fixed: the app never assigns, changes or removes
   it.
   - **Who the organizer is** comes from the tournament's own data, as S6 records it
     (an organizer record or field). The adapter exposes it as
     `Tournament.organizerPlayerId`. It is per tournament, not per league, so the
     organizer of one tournament may still staff another.
   - **Refused at entry:** adding the organizer's player id to that tournament's staff
     is 422 `organizer_cannot_staff`, checked against a fresh read. If play-tools can't
     be reached, the add fails with the usual upstream error rather than skipping the
     check.
   - **Refused at apply:** the job checks again in the plan and before each call
     (decision 8's re-read). An organizer row ends `is_organizer`, and nothing is sent.
   - **Not a role:** `organizer` is never offered by `GET /staff/roles` and is
     `unknown_role` if submitted. Staff search shows the organizer disabled, tagged
     "Organizer".

## Alternatives considered

- **Fire each assignment immediately, synchronously.** Simpler UI, but it skips the
  plan and the re-read that decision 8 needs. It would also leave no History, and
  calls would not be serialized with the league's other jobs. Rejected.
- **A separate staffing job runner.** That would duplicate the lease, SSE, crash
  recovery and shutdown handling that undo and clear already reuse. Rejected.
- **Fold staff into the attendance submission (one job).** The two target different
  upstream resources, and the organizer runs them at different moments. Rejected.
- **Treat a tournament as the date's play session.** Simpler, because the play-session
  resolver already exists. But play-tools shows tournaments as a separate resource,
  and a date can hold tournaments and sessions that don't line up one to one.
  Rejected.
- **Let upstream's duplicate rule catch it** (send, then map a duplicate error).
  Rejected: the organizer's rule is that the app must never *attempt* such an
  assignment, and the duplicate rule has only been seen on play sessions.
- **A curated staff list (like Regulars).** This is more to maintain, and the request
  defines the list by history ("people who have staffed our tournaments before"). It
  can be added later as a `pinned` flag if needed.

## Consequences

- (+) Re-applying is safe: the plan only sends what upstream is missing, so a retry
  never double-assigns.
- (+) The app never sends an assignment for a player id the tournament already lists,
  or for its organizer. The guarantee rests on a fresh read, not on upstream refusing
  the call.
- (+) Removal is explicit and limited to what this app created, so ADR-0004's
  "never auto-delete upstream records" holds.
- (+) History becomes the audit trail for staffing, which is the evidence staff need
  if points go missing.
- (+) Staffing and attendance don't constrain each other's order.
- (−) A second upstream resource (tournaments) joins play sessions, with its own
  listing, date matching and fixtures to maintain in the adapter.
- (−) `submission` grows another `kind`, and `submission_item` grows a nullable
  `role` column.
- (−) Nothing can be built until S6 has recorded fixtures. Until then the adapter
  contract is a guess.

## Open questions (answers update this ADR before it is accepted)

| #  | Question                                                                          | Assumed until answered                                       |
| -- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Q1 | Which calls do the tournament list and its staff section make? (S6 capture)       | A tournament resource with its own list, assign and remove calls |
| Q2 | ~~Is a tournament the weekly play session or a separate resource?~~               | **Answered 2026-10-11:** separate (organizer, from the play-tools UI). S6 confirms at the API |
| Q3 | Which roles does play-tools offer?                                                | Roles from upstream when listed. (One person per tournament is a rule, decision 8) |
| Q4 | Should staff already on play-tools seed the staff list?                           | No: only staff entered through this app                      |
| Q5 | How does a date map to its tournaments (start date in the league `TZ`, statuses)? | Same rule as §4.4: start within the local day                |
