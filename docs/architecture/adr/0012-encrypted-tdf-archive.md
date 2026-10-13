# ADR-0012: Keep TDF files, encrypted at rest

- Status: Accepted (2026-10-12, M9)
- Date: 2026-10-12
- Amends: architecture §5 ("TDF privacy"), §9 (minors' PII, malicious TDF) and §10 (secrets, backups); the
  CLAUDE.md security rule "never persist TDF birthdates or raw TDF files"; [ADR-0011](0011-tdf-results-upload.md)
  decision 5 (the raw file only passes through)
- Amended by: [#101](https://github.com/Towerism/play-pokemon-attendance-web/issues/101) (2026-10-13, from the PR #83
  review): a corrected file replaces its original only after re-pointing the attendance imports that use it
  (decisions 1, 4); automatic deletes skip referenced files, and `kept_reason` becomes the set `kept_for`
  (decisions 3, 5); the docs say plainly that an appdata backup can open the archive (decision 6)
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
   card for results (ADR-0011). It is kept whole and byte for byte as dropped, with one exception: when the app
   corrects a file before sending it (ADR-0011 decision 8), the corrected file replaces the original, and the
   attendance imports that used the original are re-pointed to it (decision 4). So the archive holds what TOM wrote,
   or what was sent to play-tools when the app corrected it. Nothing extracted from it changes: the parser still reads only names, ids and the
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
   - `markKept(fileId, reason)`, which adds `attendance`, `results` or `play-tools` to the file's `kept_for` set
     (#101: a file can be kept for more than one reason);
   - `replace(originalId, corrected)` → `{fileId}`: stores the corrected file, re-points every `TDF_UPLOAD` that uses
     the original (each keeps its `sha256`, the file as dropped), and deletes the original unless a results
     upload still uses it, all in one transaction (#101);
   - `delete(fileId)` → `{referencedBy}`: the organizer's explicit delete. It removes the ciphertext and reports the
     rows that pointed at it; those keep their SHA-256 and show "file deleted".

   Only this module touches the cipher for TDFs.

4. **Simpler handling that follows from it.**
   - **Attendance import (M3):** the preview stores the file and the `TDF_UPLOAD` row points at it. Commit parses it
     again from the archive instead of reading staged rows. `TDF_UPLOAD_PLAYER` is dropped (in a new migration; the
     shipped ones are not edited), along with the code that fills and expires it. A re-drop of the same file is
     recognised by its SHA-256, as today.
   - **Results upload (ADR-0011):** the preview stores the file once for both the attendance import and the results
     upload. **Upload again…** runs validate again from the archive, after the send dialog (each validate is a send;
     ADR-0011 decisions 5 and 7). The organizer never has to drop the file again. Confirm still sends only the
     `upload_guid`.
   - **One drop, one stored file**, whichever features use it. When the app corrects a file before sending (an empty
     tournament id filled in, or the organizer replaced: ADR-0011 decision 8), **only the corrected file is kept**
     (organizer, 2026-10-12). `replace` stores it, re-points every attendance import (`TDF_UPLOAD`) that used the
     original to it, and deletes the original, in one transaction (organizer, 2026-10-13; #101). The players are the
     same, because a correction changes only the organizer and an empty id. The original's SHA-256 is kept on the
     upload rows (a re-pointed `TDF_UPLOAD` keeps its `sha256`), so a re-drop of it is still recognised. The original
     stays only while another **results** upload uses it.

5. **Handled with care.**
   - **Who can read it:** only a logged-in organizer, through `GET /tdf-files/{id}/download` or a tournament's
     **Download TDF** (decision 7). Both answer with `Content-Disposition: attachment`, `Cache-Control: no-store`
     and the original file name. Each download writes one log line (file id, who, when), never the content or a
     player. No other route returns the file or a birthdate.
   - **What lists it:** History, and each tournament card's Results section, list the stored files (name, tournament,
     date, size, when and by whom) with **Download** and **Delete**. Settings shows the archive's size and file count.
   - **Abandoned previews don't pile up.** A file that was only previewed (never committed for attendance nor
     confirmed for results) is deleted with its preview after a day. A file committed or confirmed is marked kept,
     with the reason added to its `kept_for` set, and a file is an expirable preview only while that set is empty.
     **No automatic delete removes a file a row still points at** (#101): the expiry run and `replace` skip it.
   - **Kept until the organizer deletes it.** **Delete** removes the ciphertext at once, and its answer lists the
     rows that pointed at it. Those keep their SHA-256 and show "file deleted", so History still says which file it
     was, and **Upload again…** on them asks for the file to be dropped again. There is no automatic expiry yet (Q1).
   - **Logs and errors:** the parser's and adapter's existing rules hold. No body is logged, and `payload` and
     `content` join the redaction list. A decrypt failure logs the file id and "wrong key or tampered", nothing else.

6. **Backups and key loss.**
   - `app.db` (and Litestream replicas) carry only ciphertext. The key lives in `secrets/`, which Litestream never
     replicates.
   - **An appdata backup can open the archive** (#101). The recommended backup archives the whole appdata folder,
     `secrets/tdf-vault.key` included, next to `app.db`. Anyone with that backup can decrypt every stored TDF, minors'
     birthdates included. Encryption at rest protects Litestream replicas and a copy of `app.db` on its own, not an
     appdata backup. The deploy guide says so, and says to keep backups somewhere only the organizer can read
     (organizer, 2026-10-13: no extra override or field; `NUXT_TDF_VAULT_KEY` stays an env-only option and isn't
     added to the Unraid template).
   - **Restore needs `secrets/` with `app.db`**, as the deploy guide already says. This key raises the stakes:
     - losing `token-vault.key` costs a reconnect;
     - losing `tdf-vault.key` **loses the archive**. play-tools still holds the results, and the app's attendance
       data is unaffected.

     The deploy guide and Settings say so, and the restore drill checks that a stored TDF opens after a restore.
   - A file that can't be decrypted (wrong key) shows as "can't be opened with this install's key". It can be deleted,
     and nothing else breaks. That includes `app.db` restored without `secrets/`: startup generates a new TDF key, and
     the old files can't be opened.

7. **Download a tournament's TDF** (organizer, 2026-10-12). Each tournament has a **Download TDF** action: on its
   This week card (Results section) and on its row on the Tournaments page. `GET /tournaments/{id}/tdf`, as a
   connected professor:
   - **From the archive first:** the file kept for that tournament's results, the corrected one when the organizer
     was replaced (ADR-0011 decision 8). If several were confirmed (a retry with another file), the latest confirmed
     one is served, and the Results section lists the others.
   - **Else from play-tools:** when the app holds no file for the tournament (results uploaded directly in
     play-tools, or before this app kept TDFs), the app fetches play-tools' own copy as the tournament's organizer.
     The S8 bundle shows `GET triumph/tournament/{display_id}/uploads/` (the upload history) and
     `GET triumph/tdf/{uploadGuid}` (the file). It takes the latest accepted `tdf` upload, **stores it in the archive**
     (encrypted, `source = play-tools`, so the next download is local), and serves it. Its shape and permissions are
     S8 part 2's to confirm (Q3).
   - **Nothing to download:** a tournament with no results anywhere answers 404 `no_tdf`, and the action is hidden on
     a tournament still awaiting results.
   - **Organizer only for the fetch.** Fetching from play-tools runs as the tournament's organizer (ADR-0009). If they
     can't act, the archive copy is still served, and with none the answer is 409 `organizer_not_connected` /
     `needs_reconnect`. It is a read, so it isn't paced, but it doesn't run while a job holds the lease
     (`submission_running`), as for other upstream calls from a page.

## Consequences

- (+) A bookkeeping copy of every tournament file, downloadable later, for disputes, support tickets and
  re-imports.
- (+) Simpler TDF handling: no staging table, and results uploads can re-validate without the organizer finding the
  file again.
- (+) A stolen copy of `app.db` or a Litestream replica reveals no birthdates without a key the database never holds.
- (+) Separate keys keep the two secrets' failure modes and exposure apart.
- (−) The app now holds minors' birthdates (encrypted). A compromise of the running container, or of `app.db`
  *and* `secrets/` together, exposes them. **The recommended appdata backup is such a pair** (decision 6), so it must
  be kept somewhere only the organizer can read. That was not possible before.
- (−) One more secret to back up. Losing it loses the archive.
- (−) The database grows by roughly the compressed size of each file kept (tens of KB each). That is negligible at
  league scale.
- (−) M3 code changes: the preview/commit path, a new migration dropping `tdf_upload_player`, and its tests.

## Open questions

| #  | Question | Status |
| -- | -------- | ------ |
| Q1 | Should stored TDFs expire automatically after some time (e.g. after the season, or N years), or stay until deleted? | **Open: organizer.** Designed as kept until deleted |
| Q2 | Should TDFs already imported before this change be recoverable? | **Partly:** the app never kept them, but a tournament whose results reached play-tools can be fetched back from play-tools on download (decision 7) |
| Q3 | Shapes and permissions of `triumph/tournament/{display_id}/uploads/` and `triumph/tdf/{uploadGuid}` for an organizer | **Answered (S8 part 2, 2026-10-13):** the uploads list works for the organizer. It is a bare list of `{guid, tournament_id, kind, accepted, errors, uploader, upload_timestamp, upload_expiration}`, rejected validations included. **`triumph/tdf/{uploadGuid}` is 403 `op.generic.forbidden` for the organizer**, even for an upload they just made, so decision 7's fetch-back and Q2's "fetched back from play-tools" don't work as designed. Follow-up: #107 |

## Tests these decisions need

Added by #101 for #88 and #97 (spec and full plan on #101).

- **Module (`tdf-archive`, on a real temp SQLite file):**
  - `replace` re-points every `TDF_UPLOAD` that used the original, keeps its `sha256`, and deletes the original in
    the same transaction; when a results upload still uses the original, the original is kept;
  - the expiry run, with an injected `now`, deletes only files whose `kept_for` set is empty and that no row points
    at;
  - no sequence of drops, corrections and expiry runs leaves a row pointing at a missing file.
- **Server, over HTTP:** `GET /tdf-files`, `GET /tdf-files/{id}/download` and `DELETE /tdf-files/{id}`:
  - 401 with no session;
  - 404 for another league's file;
  - 409 `tdf_key_mismatch` for a file this install's key can't open;
  - `Content-Disposition: attachment` and `Cache-Control: no-store` on download;
  - no birthdate in any answer but the download itself;
  - delete answers `referencedBy`, and the rows show "file deleted".
- **Restore drill:** a stored TDF opens after a backup → restore, and `app.db` restored without `secrets/` shows
  "can't be opened with this install's key" without breaking anything else.
