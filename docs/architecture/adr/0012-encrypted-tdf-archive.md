# ADR-0012: Keep TDF files, encrypted at rest

- Status: Proposed (M9)
- Date: 2026-10-12
- Amends: architecture §5 ("TDF privacy"), §9 (minors' PII, malicious TDF) and §10 (secrets, backups); the
  CLAUDE.md security rule "never persist TDF birthdates or raw TDF files"; [ADR-0011](0011-tdf-results-upload.md)
  decision 5 (the raw file only passes through)
- Builds on: [ADR-0003](0003-pokemon-auth-pkce-refresh-token.md) (the token vault's AES-256-GCM format),
  [ADR-0006](0006-docker-on-unraid.md) (secrets generated once in `/data/secrets/`)

## Context

Since M3 the app has never kept a `.tdf`. It parses the file in memory, keeps names and player ids, and throws the
file away, because a TDF holds every player's birthdate, and many players are minors. ADR-0011 kept that rule for
results uploads: the file passes from memory to play-tools, and only its SHA-256 is kept.

The organizer (2026-10-12): **storing TDFs is fine, and even good for bookkeeping, but the information is sensitive
and should be handled with care. Keeping them encrypted at rest would be a good idea.** This also simplifies TDF
handling: today the M3 import stages parsed players in `TDF_UPLOAD_PLAYER` between preview and commit, and an
ADR-0011 results upload whose `upload_guid` expires needs the file dropped again.

## Options considered

1. **Keep the rule: never store the file.** It is the safest, but there is no bookkeeping copy, the staging table
   stays, and uploads can't be retried from the app.
2. **Store the file in plaintext** (database or `/data`). It is simple, but every copy of `app.db`, every Litestream
   replica and every Appdata backup would carry minors' birthdates in the clear.
3. **Store it encrypted with the token vault's key.** That is one key to manage, but it mixes two secrets with
   different failure modes: losing the token key costs a reconnect, while losing the archive key loses the archive.
   It also widens what one leaked key opens.
4. **Store it encrypted, with its own key**, in the database.

## Decision

Option 4.

1. **What is kept.** Every `.tdf` the organizer drops is kept: on This week for attendance (M3), and on a tournament
   card for results (ADR-0011). It is kept whole and byte for byte, as the organizer's record of what TOM wrote and
   what was sent to play-tools. Nothing extracted from it changes: the parser still reads only names, ids and the
   tournament's metadata. **Birthdates exist only inside the encrypted file**, never in a column, a log line, an event
   or an API response other than the file download (decision 5).

2. **Encrypted at rest with its own key.**
   - **Key:** a new secret, `NUXT_TDF_VAULT_KEY`, or `/data/secrets/tdf-vault.key`, generated once on first boot
     (mode 0600). It is resolved exactly like the token vault key (ADR-0006): env wins, a malformed value fails
     startup, and it is never silently regenerated. It is never stored in the database, so a stolen `app.db` or replica
     opens no file.
   - **Format:** the token vault's AES-256-GCM layout (`version | iv | tag | ciphertext`). The vault is generalised
     to take a purpose, and the token vault is unchanged on the wire. The file is gzip-compressed before it is
     encrypted (a TDF is repetitive XML). The AAD is `tdf_file:<league_id>:<sha256>`, so a ciphertext only opens for
     its own row.
   - **Where:** a `tdf_file` table in SQLite (a blob of at most about 2 MB before compression). Being in the
     database keeps it inside the one-file backup and the restore drill, and it needs no extra path permissions on
     Unraid.
   - **Never in plaintext anywhere.** The file is encrypted in the request's memory. There are no temp files, and it
     is decrypted only in memory, to parse, validate or download.

3. **A small `tdf-archive` module** (`server/modules/tdf-archive/`) owns `tdf_file` and the key. `sessions`
   (attendance import) and `tournaments` (results upload) use it only through its service:
   - `store(leagueId, {filename, content, by})` → `{fileId, sha256, alreadyStored}`, deduplicated on `(league_id,
     sha256)`;
   - `read(fileId)` → content;
   - `list(leagueId, filter)`;
   - `markKept(fileId, reason)`;
   - `delete(fileId)`.

   Only this module touches the cipher for TDFs.

4. **Simpler handling that follows from it.**
   - **Attendance import (M3):** the preview stores the file and the `TDF_UPLOAD` row points at it. Commit parses it
     again from the archive instead of reading staged rows. `TDF_UPLOAD_PLAYER` is dropped (in a new migration; the
     shipped ones are not edited), along with the code that fills and expires it. A re-drop of the same file is
     recognised by its SHA-256, as today.
   - **Results upload (ADR-0011):** the preview stores the file once for both the attendance import and the results
     upload. If play-tools has forgotten the `upload_guid` by confirm time, or a retry needs it, the job runs
     validate again from the archive. The organizer never has to drop the file again. Confirm still sends only the
     `upload_guid`.
   - **One drop, one stored file**, whichever features use it. A file the app corrected before sending (the
     organizer replaced, ADR-0011 decision 8) is a second stored file, kept alongside the original, so the archive
     holds both what TOM wrote and what play-tools received.

5. **Handled with care.**
   - **Who can read it:** only a logged-in organizer, through `GET /tdf-files/{id}/download`. It answers with
     `Content-Disposition: attachment`, `Cache-Control: no-store` and the original file name. Each download writes one
     log line (file id, who, when), never the content or a player. No other route returns the file or a birthdate.
   - **What lists it:** History, and each tournament card's Results section, list the stored files (name, tournament,
     date, size, when and by whom) with **Download** and **Delete**. Settings shows the archive's size and file count.
   - **Abandoned previews don't pile up.** A file that was only previewed (never committed for attendance nor
     confirmed for results) is deleted with its preview after a day. A file committed or confirmed is marked kept.
   - **Kept until the organizer deletes it.** **Delete** removes the ciphertext at once. The SHA-256 stays on the
     upload rows, so History still says which file it was. There is no automatic expiry yet (Q1).
   - **Logs and errors:** the parser's and adapter's existing rules hold. No body is logged, and `payload` and
     `content` join the redaction list. A decrypt failure logs the file id and "wrong key or tampered", nothing else.

6. **Backups and key loss.**
   - `app.db` (and Litestream replicas) carry only ciphertext. The key lives in `secrets/`, which Litestream never
     replicates.
   - **Restore needs `secrets/` with `app.db`**, as the deploy guide already says. This key raises the stakes:
     - losing `token-vault.key` costs a reconnect;
     - losing `tdf-vault.key` **loses the archive**. play-tools still holds the results, and the app's attendance
       data is unaffected.

     The deploy guide and Settings say so, and the restore drill checks that a stored TDF opens after a restore.
   - A file that can't be decrypted (wrong key) shows as "can't be opened with this install's key". It can be deleted,
     and nothing else breaks.

## Consequences

- (+) A bookkeeping copy of every tournament file, downloadable later, for disputes, support tickets and
  re-imports.
- (+) Simpler TDF handling: no staging table, and results uploads can re-validate without the organizer finding the
  file again.
- (+) A stolen database or backup reveals no birthdates without a key the database never holds.
- (+) Separate keys keep the two secrets' failure modes and exposure apart.
- (−) The app now holds minors' birthdates (encrypted). A compromise of the running container, or of `app.db`
  *and* `secrets/` together, exposes them. That was not possible before.
- (−) One more secret to back up. Losing it loses the archive.
- (−) The database grows by roughly the compressed size of each file kept (tens of KB each). That is negligible at
  league scale.
- (−) M3 code changes: the preview/commit path, a new migration dropping `tdf_upload_player`, and its tests.

## Open questions

| #  | Question | Status |
| -- | -------- | ------ |
| Q1 | Should stored TDFs expire automatically after some time (e.g. after the season, or N years), or stay until deleted? | **Open: organizer.** Designed as kept until deleted |
| Q2 | Should TDFs already imported before this change be recoverable? | **Not possible:** they were never kept |
