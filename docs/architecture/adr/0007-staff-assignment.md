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
   - `listStaff`
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
   - **Plan:** read the event's staff upstream.
     - `toAssign` = wanted (player, role) pairs not already there.
     - `toRemove` = staff records **this app created** whose assignment the organizer
       has since removed.
     - Staff assigned directly in play-tools are shown, and **never** deleted
       (ADR-0004).
   - **Execute:** one call at a time, at least `NUXT_STAFF_DELAY_MS` apart (default
     1 s, never under 500 ms). There is no bulk call: staff counts are in the single
     digits.
   - **Reconcile:** re-read upstream, then mark each item
     `assigned`/`already_assigned`/`removed`/`failed`. Record ids are written back
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
   - If someone already holds a *player* record when their staff assignment is
     applied, the staff job:
     - changes the record's role with `PATCH`, if S6 shows that works and play-tools
       does the same;
     - otherwise fails the item with `holds_player_record` and tells the organizer
       to fix it in play-tools.

   It never deletes and re-adds a player record.

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
- **A curated staff list (like Regulars).** This is more to maintain, and the request
  defines the list by history ("people who have staffed our events before"). It can
  be added later as a `pinned` flag if needed.

## Consequences

- (+) Re-applying is safe: the plan only sends what upstream is missing, so a retry
  never double-assigns.
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
| Q3 | Which roles does play-tools offer? Can one person hold two roles at one event?              | Roles from upstream when listed. One person, one role per event (S4 rule) |
| Q4 | Should staff already on play-tools seed the staff list?                                     | No: only staff entered through this app                                  |
