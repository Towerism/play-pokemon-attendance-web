# ADR-0005: Curation metrics from sightings, not submissions

- Status: Proposed
- Date: 2026-10-10

## Context

G5 asks for per-player metrics so the regulars list can be curated by hand.
But regulars are submitted every session by design, whether they attended or
not. Counting submissions would make every regular look 100% present and
would hide exactly the drift the organizer wants to see.

## Decision

Store **sightings**, which are evidence of physical attendance on a date:

- `tdf`: the player appears in an uploaded TDF.
- `manual`: the player was added to session players by hand, or a regular was ticked "present" on the This week screen.
- `upstream_existing`: the player was already recorded upstream before we submitted (someone entered them in play-tools).

Metrics (windowed counts, rate, streak, last seen) are computed on read from
sightings with SQL views. Submissions are kept separately for audit
(`times_submitted`).

## Consequences

- (+) "Promotion candidates" and "stale regulars" reflect reality.
- (−) A regular who attends but doesn't play in the tournament leaves no TDF evidence. This is mitigated by the one-tap "present" checkbox, and the UI labels the metric "seen in events" so it isn't over-trusted.
- (+) Views are recomputed on read, so threshold or definition changes need no backfill.
