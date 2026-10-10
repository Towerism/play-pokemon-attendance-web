# ADR-0004: Idempotent diff-based submission (plan → execute → reconcile)

- Status: Proposed
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
