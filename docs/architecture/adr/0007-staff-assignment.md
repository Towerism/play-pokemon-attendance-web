# ADR-0007: Assign staff to events as desired state, applied by a reconcile job

- Status: Proposed
- Date: 2026-10-11
- Issue: [#41](https://github.com/Towerism/play-pokemon-attendance-web/issues/41)

## Context

On the same weekly visit where attendance is taken, the organizer assigns one or
more staff members to the night's tournament in play-tools. There are sometimes
several tournaments on one date. That assignment is how staff earn points for
staffing the event. Each assignment needs a **player ID** and a **role**. Several
people can be assigned, with different roles or the same role. The organizer
wants to search a **staff list**: people who have staffed this league's events
before and were entered through this app.

The v1 architecture listed "staff" as a non-goal (§2), so this needs a decision
rather than a quiet addition.

What we know about upstream (spikes S3/S4, [spikes.md](../spikes.md)):

- Attendance records already carry a `role` and a `player` flag. Every play session
  gives its creator a hidden record with `player: false, role: "organizer"`.
- Upstream refuses a second record for a participant who already holds one in **any**
  role (`op.activity_record.cannot_duplicate_participant`). If staff are records on
  the play session, one person can't be both a player and staff there, or hold two
  staff roles.
- The bundle has `POST …/records/` (single add) and `PATCH …/records/{id}/`, never
  called. No role list, no staff screen and no tournament endpoint has been captured.
- The organizer's rule: the app must **never attempt** to assign a staff member to a
  tournament that already lists the same player id.

What we don't know yet is the subject of **spike S6**:

- the endpoints the tournament page's staff section calls;
- whether a "tournament" is a play session or a separate upstream event;
- the role list;
- what happens when a staffer already holds a record.

## Decision

1. **Staff assignment is in scope** as goal G6. Other play-tools features
   (creating tournaments, reporting) remain non-goals.

2. **A new `staffing` module** (`server/modules/staffing/`) owns everything local about
   staff:
   - the per-date assignments the organizer wants;
   - their upstream state;
   - the staff-list search.

   It talks to `roster` only through `RosterService` (to make a staffer a known
   `PLAYER`), and to upstream only through `PlayToolsGateway`.

3. **Upstream sits behind an event-neutral port.** `PlayToolsGateway` gains:
   - `listStaffableEvents`
   - `listStaffRoles`
   - `listEventRecords` (every record the event lists, players and staff)
   - `assignStaff`
   - `unassignStaff`

   They take an opaque `StaffEventRef`. Whether the adapter fills that from play
   sessions or from a separate tournament resource is S6's answer, and the
   domain doesn't change either way. The role list comes from upstream when S6
   finds a source. Otherwise it comes from a list the adapter keeps, and roles
   are stored as text either way.

4. **Assignments are desired state.** The organizer edits a list per date and event;
   nothing goes upstream until they click **Assign staff in play-tools**. Applying
   is a job of `kind = 'staff'` on the submission rails, with the same pieces as
   undo and clear:
   - the per-league lease;
   - the event log and SSE;
   - crash recovery and shutdown;
   - retry that re-reads first;
   - History.

   The job runs plan → execute → reconcile:
   - **Plan:** read **everything the event lists** upstream: every record, any role,
     players and staff alike.
     - `toAssign` = wanted assignments whose player id the event doesn't list at all.
     - A wanted player the event already lists in the same role is `already_assigned`,
       and the job adopts that record id.
     - A wanted player the event lists in any other way (as a player, or as staff in
       another role) is `already_listed`. **Nothing is sent for them** (decision 8).
     - `toRemove` = staff records **this app created** whose assignment the organizer
       has since removed.
     - Staff assigned directly in play-tools are shown, and **never** deleted
       (ADR-0004).
   - **Execute:** one call at a time, at least `NUXT_STAFF_DELAY_MS` apart (default
     1 s, never under 500 ms). There is no bulk call: staff counts are in the single
     digits.
   - **Reconcile:** re-read upstream, then mark each item
     `assigned`/`already_assigned`/`already_listed`/`removed`/`failed`. Record ids are written back
     to the assignment for later removal.

5. **The staff list is derived from the app's own assignments**, not curated. A staffer
   is any player with at least one assignment entered through this app that reached
   play-tools. Search ranks by most recent, then most often. Each result shows the
   last role used, so it can pre-fill the role. No new list needs maintaining, and
   it matches the request word for word. Staff found only upstream are not added
   (but see open question Q4).

6. **Staff assignments are not sightings.** Following ADR-0005 and S4 design change 6,
   a staff role is not evidence of playing. Curation metrics are unchanged.

7. **Order against attendance.** For the case where staff records live on the play
   session, an attendance submission already counts a staff record as
   `already_present (as_staff)`. So staff are applied **before** attendance:
   - The Submit dialog warns when the chosen play session has staff not yet applied,
     and offers to apply them first.
   - If someone is already listed as a *player* when their staff assignment is
     applied, the item ends `already_listed`, and History shows how they are listed.
     The organizer fixes it in play-tools if they want. The app never changes their
     record's role, and never deletes and re-adds it.

8. **Never attempt to assign a player id the event already lists.** This is the
   organizer's rule, and it is absolute. It doesn't depend on whether play-tools would
   refuse the call:
   - **Checked against upstream, not memory.** Immediately before each assign call, the
     job re-reads the event's listing (every page). If the player id is now there in
     any role, it skips the call. A staffer is a handful of records, so the extra read
     is cheap, and it closes the gap between plan and call (someone editing in
     play-tools, or an attendance submission that just finished).
   - **No blind retries.** After a 5xx or a timeout the call may have landed, so the
     job re-reads before deciding. If the player id is listed, the item is `assigned`
     (with our role) or `already_listed`, never sent again.
   - **One player per event, locally too.** `STAFF_ASSIGNMENT` is unique on
     `(league_id, event_ref, player_id)` while not removed. The add route refuses a
     second role for the same player with 409 `player_already_staffed`. Staff search
     shows players the event already lists as disabled, with how they are listed.
   - The ids are compared exactly as text, so leading zeros count.

## Alternatives considered

- **Fire each assignment immediately, synchronously.** Simpler UI, but it bypasses the
  lease. It could race an attendance submission on the same play session, with the
  duplicate-participant rule making the outcome order-dependent. It would also leave
  no History. Rejected.
- **A separate staffing job runner.** That would duplicate the lease, SSE, crash
  recovery and shutdown handling that undo and clear already reuse. Rejected.
- **Fold staff into the attendance submission (one job).** This would tie staff to play
  sessions before S6 says tournaments are play sessions, and couple two flows the
  organizer runs at different times. Rejected for now. The Submit dialog's "apply
  staff first" offer gives most of the benefit.
- **Let upstream's duplicate rule catch it** (send, then map
  `cannot_duplicate_participant`). Rejected: the organizer's rule is that the app must
  never *attempt* such an assignment. S4 only showed the duplicate rule for
  play-session records, so it may not hold for tournament staff at all.
- **A curated staff list (like Regulars).** This is more to maintain, and the request
  defines the list by history ("people who have staffed our events before"). It can
  be added later as a `pinned` flag if needed.

## Consequences

- (+) Re-applying is safe: the plan only sends what upstream is missing, so a retry
  never double-assigns.
- (+) The app never sends an assignment for a player id the event already lists.
  The guarantee rests on a fresh read, not on upstream refusing the call.
- (+) Removal is explicit and limited to what this app created, so ADR-0004's
  "never auto-delete upstream records" holds.
- (+) History becomes the audit trail for staffing, which is the evidence staff need
  if points go missing.
- (+) S6 can land any answer (play-session records, a separate tournament resource,
  role enum or free text) without changing the domain, routes or UI. Only the adapter,
  its fixtures and the fake change.
- (−) `submission` grows another `kind`, and `submission_item` grows a nullable
  `role` column.
- (−) Nothing can be built until S6 has recorded fixtures. Until then the adapter
  contract is a guess.
- (−) If staff are play-session records, a person can't be both staff and a player
  on that session. That is an upstream rule we surface, not one we can fix.

## Open questions (answers update this ADR before it is accepted)

| #  | Question                                                                                    | Assumed until answered                                                   |
| -- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Q1 | Which endpoints does the tournament staff section call? (S6 capture)                        | Single-record `POST …/records/` with a `role` and `player: false`         |
| Q2 | Is a "tournament" the weekly play session, or a separate event (League Challenge, Cup)?     | The play session(s) on that date. The port allows either                 |
| Q3 | Which roles does play-tools offer?                                                          | Roles from upstream when listed. (One person per event is now a rule, decision 8, not a question) |
| Q4 | Should staff already on play-tools seed the staff list?                                     | No: only staff entered through this app                                  |
