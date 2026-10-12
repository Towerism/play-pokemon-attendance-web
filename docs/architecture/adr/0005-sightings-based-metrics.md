# ADR-0005: Curation metrics from sightings, not submissions

- Status: Accepted (retroactively, 2026-10-12; implemented in M6)
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

## Update (M6, 2026-10-10)

The metrics are computed on read as decided, but by one parameterized SQL query (CTEs) rather than
`CREATE VIEW`s. The windows depend on today, in the league timezone, and on the organizer's thresholds,
which a view can't take as parameters. Nothing is stored, so changing a definition or a threshold still
needs no backfill. "A league session was held" means a date with any sighting in the league. Details
are in architecture §5, "As built (M6)".

## Update (M7, 2026-10-11)

**Undo retracts evidence.** When an undo removes a record from play-tools (or finds it already gone), the
player's `tdf` and `manual` sightings for that date are retracted and they come off the date's session players,
in the same transaction as the undo's outcome for them. It follows the rule removing a session player by hand
already applies (§5: "the organizer is saying they weren't there"). The organizer's reasoning: either the
removal was an accident, and the player will be added again anyway, or the add was, and the sighting needs
correcting. `upstream_existing` sightings stay, since they record someone else's entry in play-tools, and so do
the sightings of a player another play session that day still has. Metrics are computed on read, so nothing is
backfilled: the player's counts, last seen and streak drop that date, and a date left with no sightings at all
stops counting as a session held. The decision above is unchanged; this is one more way evidence is retracted.

**Clear session also retracts `upstream_existing`** (#15). Unlike an undo, it deletes the very records entered
in play-tools by someone else, so the evidence behind that sighting is gone too. A cleared player loses every
sighting for that date, unless another play session that day still has them.

