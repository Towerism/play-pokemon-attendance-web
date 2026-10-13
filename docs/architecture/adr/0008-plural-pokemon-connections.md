# ADR-0008: Plural Pokémon connections, keyed by professor player ID

- Status: Proposed (#66)
- Date: 2026-10-12
- Amends: [ADR-0003](0003-pokemon-auth-pkce-refresh-token.md) (one connection per league)
- Amended by (proposed): [ADR-0011](0011-tdf-results-upload.md) decision 8: a connection also stores the professor's optional **full name**, like the display name: offered from play-tools' organizer name, confirmed by the organizer, and written into a TDF whose organizer is replaced
- Amended by: [ADR-0009](0009-tournaments-as-their-organizer.md): only attendance calls go through the submitting professor; tournament calls go through each tournament's organizer, and the league must be one every professor shares (#75)

## Context

ADR-0003 gives the league one Pokémon connection: one refresh token, keyed by `league_id`, with the chosen
upstream league (activity group) stored on the same row. Connecting a second Pokémon account replaces the
first one. The app keeps only the access token's `sub`, so it can't say whose account is connected.

The organizer wants several organizer logins in one install. Each one is a Pokémon account that stays refreshed,
named after its professor and identified uniquely by that professor's player ID. Several professors of the same
league can then stay connected. Attendance goes in under the one the organizer picks, and History shows who
submitted (#66).

Facts this relies on (spikes S5 and S7):

- `GET core/users/{sub}/activity_groups/` returns a `group_type: "personal"` group whose `owner.player_id` is the
  caller's own player ID. A league group's `owner` is the store owner, a different person, and is never used.
- Upstream, a league isn't tied to one account: `criteria` describes the *caller's* permissions, so several
  professors can each see and submit to the same league.
- Pokémon doesn't expose the professor's name: S7 (2026-10-12) found none in the `id_token` claims or in
  `https://me.pokemon.com/me` (`organized_play` holds only `player_id`, `player_rankings_opt_in`, `terms`).

## Options considered

1. **Keep one connection per league (status quo).** Simple, but it can't keep a second professor's token alive,
   and it still can't say who submitted.
2. **Plural connections; the league names one submitting connection.** Every connection is refreshed, and the
   organizer picks which professor submits for the league. A connection that needs a reconnect blocks submission
   until it is reconnected or another professor is picked.
3. **Plural connections with automatic failover.** Like 2, but submission falls back to any connected professor
   with `canSubmit`. It has more uptime, but attendance can land under a professor nobody chose. That is an identity
   mistake on an official record, and it is worse than a clear refusal.
4. **Plural app users, each with their own connection.** It solves a different problem (several people logging
   into the app), and it needs its own auth and permission design. Plural connections don't depend on it.

## Decision

Option 2.

**Data:**

- `pokemon_connection` is rebuilt:
  - the key is a surrogate `id`;
  - `professor_player_id` is TEXT and UNIQUE;
  - `professor_name` is the organizer's optional display name (never from Pokémon);
  - `ptc_user_id` stays.
- The upstream binding moves to a new `league_upstream` table: the league, the submitting `connection_id` (ON DELETE CASCADE) and the
  activity group. Account identity and league choice are no longer fused in one row.
- `submission` records the professor player ID and name it ran under.

**Tokens (ADR-0003 rules, now per connection):**

- Each connection has its own sealed refresh token, access-token cache, refresh mutex and status.
- The vault's AES-GCM AAD is `pokemon_connection:<id>`, so a ciphertext moved to another row doesn't open.
- The rotated token is still persisted before its access token is used.
- `invalid_grant` marks only that connection `needs_reconnect`.

**Identity at connect:**

- After the code exchange, the gateway reads the personal group's `owner.player_id`. No name is asked for (S7).
- A player ID that is already connected is a reconnect: the token and status are replaced; the display name and the binding are kept.
- A new player ID adds a connection, up to 10 per install.
- No player ID means the connect fails and nothing is stored.
- The identity is read with the fresh access token *before* the refresh token is stored, because the row's key isn't
  known until then. Nothing has rotated yet, so this can't revoke a chain; the ADR-0003 rule (persist a *rotated* token
  before using its access token) is unchanged. A connect that fails after the exchange revokes the fresh login.

**Keep-alive:** the hourly task runs the ADR-0003 rule (refresh when the last refresh is ≥ 45 min old) for every
connection, one at a time. One connection's failure doesn't stop the others.

**Submission:** tokens come only from the league's submitting connection. If it is unbound or `needs_reconnect`,
the submission is refused before any upstream write. Retry and resume use the *current* submitting professor and
record it.

**Ports:**

- `TokenProvider.getAccessToken(connectionId)` replaces the league key.
- The gateway gains `getProfessorProfile()`.
- Upstream payload shapes stay inside `server/modules/pokemon/adapters/*`.

**Upgrade (forward-only migration):**

- The SQL migration copies the existing row into the new table, with no player ID yet, and copies its binding into
  `league_upstream`.
- A boot step re-seals the ciphertext under the new AAD before any refresh can run. The SQL migration can't do this,
  because it has no vault key.
- The first successful refresh fills in the player ID, so no reconnect is needed. Identity is read only while the player ID
  is unknown, never on an identified connection's refresh.
- If that refresh gets `invalid_grant`, the row is `needs_reconnect` as today. The next connect claims it for the player ID
  read at connect, and keeps the binding (a healthy unidentified row is only claimed by the same account, `sub`).
- If the professor it turns out to be is already connected under another row, the two merge: their own row and the league
  binding stay, and the carried-over chain is revoked.

## Consequences

- (+) Several professors stay connected. Attendance goes in under an explicit, visible choice, and History says who.
- (+) Settings can say who is connected: "<display name> (<player ID>)", or "Professor <player ID>" (§8).

**Display name (#66, Q6):** the organizer may give each professor an optional name in Settings (`PATCH
/api/pokemon/connections/:playerId`): trimmed, ≤ 60 characters, no control characters, `''`/null clears. It is display
only: never sent to Pokémon, never used to identify or match a professor, not unique, kept across reconnects, and
recorded on each submission as it was when the submission started.
- (−) Hourly refresh traffic grows with the number of connections: N refreshes an hour, run one at a time. With
  the cap of 10 that's ≤ 240 calls a day, each human-scale.
- (−) More stolen-token surface: each connection is a refresh token that can act as its professor. The mitigations
  are unchanged and apply per connection: encryption at rest, per-row AAD, revoke-on-disconnect.
- (−) **Rollback.** The migration is forward-only, so the previous image can't read the new tables. The rollback is:
  1. stop the container;
  2. restore the pre-upgrade database (the backup/restore drill in `docs/deploy/unraid.md`);
  3. pin the previous image tag.

  Done that way it costs nothing. Without a backup, the fallback is one reconnect on the old version.
- (−) Names are only as good as what the organizer types; without one a professor is "Professor <player ID>".
