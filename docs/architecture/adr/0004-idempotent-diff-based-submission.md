# ADR-0004: Idempotent diff-based submission (plan → execute → reconcile)

- Status: Accepted (retroactively, 2026-10-12; implemented in M5 and M7)
- Date: 2026-10-10

## Context

The CLI POSTs the full lists every time. Re-running after a partial failure
resends everyone, and the result is only visible in console output. Someone
may also have added players directly in play-tools.

## Decision

The submission is a background job with three phases:

1. **Plan:** `toAdd = (regulars ∪ sessionPlayers) − existingUpstreamRecords`.
2. **Execute:** throttled bulk batches of ≤ 50, sent ≥ 15 s apart (configurable), session players first.
3. **Reconcile:** re-read upstream and mark each item `added`, `already_present` or `failed`.

Retry and resume always re-plan from upstream state. Players present upstream
but not desired locally are reported, never deleted automatically. A
per-league lease lock prevents concurrent submissions for the same session.

## Consequences

- (+) It is safe to click Submit twice, to retry, or to resume after a crash.
- (+) Upstream becomes the source of truth for "is this person recorded", and history becomes a trustworthy audit log.
- (+) Upstream players we didn't know about are discovered and tracked (G5).
- (−) It needs extra GETs per submission (paged `records/`), which is negligible.
- (−) It depends on `records/?player=true` returning `participant.player_id` (S4). The CLI's `delete.js` already relies on this.

## Update (M5, 2026-10-10)

- The plan diffs against the **unfiltered** records list (every role), per spike S4: a staff record blocks
  a re-add just like a player record.
- **A 5xx is not proof of failure.** The organizer has seen large `_bulk` calls answer 502 (gateway timeout),
  with every player showing up in the records about a minute later. So after a 5xx the execute step re-reads
  for a settle window (default 3 min) before it resends anyone, and a late duplicate of our own batch counts as
  added. This keeps the "never send anyone twice" guarantee without depending on the gateway's answer.
- **Smaller, quicker batches by default: 20 players, at least 10 s apart** (was ≤ 50 every 15 s; the organizer's
  call). Small batches make the gateway timeout unlikely in the first place. At about 2 players/s, the
  steady rate is below the CLI's roughly 3.3 players/s, so traffic stays human-scale. Batches still go one at
  a time, both values remain configurable (`NUXT_SUBMISSION_BATCH_SIZE`, `NUXT_SUBMISSION_BATCH_DELAY_MS`),
  and the batch size stays capped at 50.

## Update (M7, 2026-10-11)

**Deleting upstream records is always an explicit organizer action, never part of a submission.** Two M7
actions delete records in play-tools, and neither changes the decision above:

- **Undo** (#9) removes only the records one submission added, after a confirm dialog.
- **Clear session** (#15) is the one exception to "only what this app added". It deletes every *player* record
  in one play session, including records entered in play-tools directly, but never a staff record. It sits in a
  danger zone, shows a fresh preview of who would go, and runs only after the organizer types the session's
  date exactly; the server checks the typed date too. It is the web version of the CLI's `delete.js`.

Both run as jobs on the same rails as a submission: the per-league lease, one DELETE at a time at least
`NUXT_UNDO_DELAY_MS` apart, a closing re-read that decides each outcome, and retry that re-reads first, so
nothing is deleted twice. A submission itself still only adds, and reports unwanted upstream players
without deleting them. Details are in architecture §6.3.
