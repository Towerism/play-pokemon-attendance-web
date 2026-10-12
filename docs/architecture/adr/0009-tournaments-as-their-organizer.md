# ADR-0009: Tournaments are read and staffed as their organizer

- Status: Accepted (2026-10-12, #75)
- Date: 2026-10-12
- Issue: [#75](https://github.com/Towerism/play-pokemon-attendance-web/issues/75)
- Amends: [ADR-0007](0007-staff-assignment.md) (decisions 3, 5 and 11) and [ADR-0008](0008-plural-pokemon-connections.md)
  (one connection makes every upstream call for the league)

## Context

Since #66 (ADR-0008), several professors' Pokémon accounts can be connected at once, and Settings names the one who
submits attendance for the league. Every upstream call for the league went through that submitting connection,
including the This week Staff card, the staff job and Import staff.

Spike S6 (ADR-0007) found two upstream rules that make this miss staff:

- `core/activities?role=organizer` lists only the tournaments the **caller** organizes.
- Staff management is **organizer-only**: anyone else gets 403 on a tournament's records.

So on a day with several tournaments run by different professors, only the submitting professor's tournaments
showed, and the others' staff couldn't be logged here. The organizer's request (#75):

> Tournaments for all connected play-tools accounts must load for This week. The professor submitting the attendance
> doesn't matter, but sometimes multiple tournaments in a day could be organized by different professors, and we want
> to be able to log staff for all of them easily. Only the organizer of each tournament is allowed to log the staff
> for their tournaments.

They also ruled that the connected professors can't be from different leagues. The league can only be chosen from
leagues every connected professor has. Professors who lack the chosen league becoming inactive connections is a
possible follow-up, not part of this decision.

## Options considered

1. **Keep the submitting professor for everything (status quo).** This is simple, but it misses every other
   professor's tournaments.
2. **Read with every connection, but act as the submitting professor.** Upstream refuses it (403, S6), and it breaks
   "only the organizer logs staff".
3. **Read with every connection, and act on each tournament as its organizer.**
4. **Let the organizer pick a professor per tournament.** This is pointless, because only the organizer may act anyway,
   and it invites the wrong pick.

## Decision

Option 3.

- **Attendance is unchanged.** Submit, undo, clear and the play-session resolver still run as the league's
  submitting professor (ADR-0008).
- **Reading the date's tournaments** (This week): one professor at a time, each listing their own tournaments with
  their own connection, kept to the league's activity group (`league_upstream`). A tournament two connections list
  is shown and read once. Each tournament's details and participants are read with the connection that listed it.
- **Acting on a tournament** means adding, re-roling or removing staff, and the whole staff job. It uses only the connection whose
  `professor_player_id` equals the tournament's `organizer.player_id`, compared as text. There is no fallback
  to another professor:
  - no connected professor organizes it → 409 `organizer_not_connected`, and the card is read-only;
  - the organizer's connection needs a reconnect → 409 `needs_reconnect` naming them.
- **Isolation.** One professor's failure (a refused login, play-tools down) hides only their tournaments. They are
  named in the response's `unread`, and everyone else's still show. The submitting professor's status no longer
  gates the Staff card; only the league choice does.
- **Staff jobs** record the tournament's organizer as the professor they ran under, and run as them for the whole
  job. A job whose organizer can't act stops (`needs_reconnect` / `not_connected`). A retry resolves the organizer
  again.
- **Import staff** reads every connected professor's tournaments, each tournament once, as the professor who listed
  it. One professor failing is a `professor_failed` event, and the import goes on. It records no single professor.
- **The lease stays per league.** One job of any kind at a time, whoever it runs as. Staff writes are still one at a
  time and at least `NUXT_STAFF_DELAY_MS` apart.
- **Choosing the league** (Settings): the picker offers only leagues every connected professor shares, each read with
  their own connection. A professor who needs a reconnect is left out and named. Any other failure fails the
  picker, so a league is never chosen from a partial list. A connect binds a league automatically only when exactly
  one is shared.

**Ports.** `PokemonConnectionService.listActingConnections()` lists every connection (id, professor, status; never a
token). `staffing` and `submission` take `staffGateway(connectionId)` rather than a league-keyed gateway, and never
read `pokemon_connection` or `league_upstream`.

## Consequences

- (+) All of a day's tournaments are on one card list, whoever organizes them, and each is staffed under the only
  login play-tools accepts for it.
- (+) A dead login hides only its own tournaments, and the Staff section says whose.
- (+) History says which professor each staff job ran as.
- (−) A card load makes one listing per connected professor (at most 10), plus one details read and one records read
  per tournament. That is still human-scale and unpaced, as ADR-0007 allows for reads.
- (−) Finding a tournament to act on may list several professors before reaching its organizer.
- (−) A tournament whose organizer isn't a connected, identified professor can be seen but never staffed here. With
  S6's organizer-only listing, that only happens for a connection carried over from v1 that isn't identified yet.
- (−) A professor whose leagues can't be read blocks choosing a league until play-tools answers, unless they need a
  reconnect.
