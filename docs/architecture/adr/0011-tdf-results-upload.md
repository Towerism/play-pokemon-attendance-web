# ADR-0011: Upload a tournament's TDF to play-tools from its This week card

- Status: Proposed (M9)
- Date: 2026-10-12
- Amends: architecture §5 "TDF privacy" and §9 (the raw TDF now travels on to play-tools)
- Amended by (proposed): [ADR-0012](0012-encrypted-tdf-archive.md): the file is kept, encrypted at rest (decision 5)
- Builds on: [ADR-0009](0009-tournaments-as-their-organizer.md), [ADR-0010](0010-tournament-templates-and-lifecycle.md)
  (the `tournaments` module and its job kinds)
- Upstream contract: spike S8 ([spikes.md](../spikes.md#s8-tournament-lifecycle-and-tdf-upload-part-1-done-2026-10-12)), part 1 done, live capture pending

## Context

After a tournament, the organizer uploads its `.tdf` (written by TOM) to play-tools, which awards its points and
completes it. Today the same file is dropped on This week for attendance (M3), then uploaded again by hand in
play-tools. The organizer wants the upload here, **on This week, in the same card that staff are credited in**.

What S8 part 1 found:

- **Two phases.** Validate is `POST triumph/tdf/` with `{kind: "tdf", tournament_id: <display_id>, payload: <base64
  file>}`, answering `{upload_guid, errors: [code]}`. Confirm is `PUT triumph/{upload_guid}/confirm/`. (Behind a
  feature flag, validate uses a presigned URL instead.)
- **Only the organizer**, and only while the tournament is `sanctioned`, `activity_state = pending`, not complete,
  within start + 90 days, and **has no player records yet**. Once players exist, an organizer can't upload again;
  only an admin purge resets it.
- **The file must match the tournament**: its tournament id (`TDF_TOURNAMENT_ID_AND_PAYLOAD_ID_MISMATCH_ERROR`),
  organizer id (`ORGANIZER_ID_MISMATCH`) and game type (`GAMETYPE_PRODUCT_CODE_ERROR`). A player who is also on
  the tournament's staff fails it (`STAFF_PLAYERS_ERROR`).
- After confirm the tournament goes `upload_in_progress`, then `complete` or `upload_failed`. play-tools' own page
  doesn't poll.

Two rules from §9 bear on this: **never persist raw TDF files or birthdates** (relaxed by ADR-0012: kept only
encrypted at rest), and **act on a tournament only as its organizer** (ADR-0009). A TDF holds every player's
birthdate, and play-tools needs the whole file.

The organizer on a file whose organizer is wrong (2026-10-12): sometimes a TDF names a different organizer than the
tournament's. Today the organizer opens the file in a text editor and fixes the player id by hand. The app should do
that edit instead. It warns that the file's organizer will be replaced with the tournament's, asks for the
organizer's full name the first time, and saves it for the future, stored like the display name (decision 8).

The organizer on validation failures (2026-10-12): a TDF that will fail play-tools' validation may still be sent.
Sometimes that is what they want, and Pokémon support almost always resolves it from there. The app must **warn
before sending it**. The preview must also **call out every player the app doesn't know**, since those may be
(though aren't necessarily) mis-keyed player ids.

## Options considered

1. **Keep uploading in play-tools.** Zero risk, and the second drop of the same file stays.
2. **One call on drop:** validate and confirm at once. This skips the moment where upstream's validation errors can
   be read before anything is committed, and confirm is irreversible for an organizer.
3. **Preview → confirm, mirroring upstream's two phases.** Drop the file, and the app checks it locally and through
   upstream's validate, showing both. **Upload results** then confirms, as a job. Problems are warnings the organizer
   can upload past (**Upload anyway**), not refusals, except where play-tools wouldn't take an upload at all.
4. **Keep the file and upload later**, for example in a queue that survives a restart. It needed the raw file
   stored, which §9 forbade when this was written. ADR-0012 now keeps the file encrypted, which decision 5 uses for
   retries. The preview → confirm flow stays, because it is what shows the warnings.

## Decision

Option 3.

1. **Where.** Each This week tournament card (ADR-0010 decision 10) gets a **Results** section under Staff, showing
   the tournament's upload state from play-tools: *Awaiting results*, *Processing*, *Complete*, *Upload failed*, or
   why an upload isn't possible (not sanctioned yet, organizer not connected, past the window, players already
   recorded). Once the tournament has results, the section offers **Download TDF** (ADR-0012 decision 7): the
   archived file, or play-tools' copy when the app has none.

2. **One drop, both jobs.** Dropping a `.tdf` on a card previews **both** the results upload and the attendance
   import (M3) for that date. The attendance import is ticked by default (organizer, 2026-10-12), and the organizer
   can untick it. The
   page's own TDF dropzone stays for dates whose tournament isn't in play-tools.

3. **Preview** (`POST /sessions/{date}/tournaments/{tournamentId}/results`, the file's text as JSON, ≤ 2 MB). It
   sorts everything it finds into **blocks** and **warnings**:
   - **Parsed locally first** with `shared/tdf`, which learns to read the file's tournament id (`data/id`), its
     organizer's player id (`data/organizer@popid`), and its game type (`tournament@gametype`, with
     `tournament@mode`), besides names and ids. It still never reads birthdates. The shape is TOM's, as the organizer
     showed it (2026-10-12; values here are made up):

     ```xml
     <tournament type="3" stage="5" version="1.86" gametype="GO" mode="GOPREMIER">
     <data>
     <name>Example Pokemon GO Challenge</name>
     <id/>
     <city>…</city> <state>…</state> <country>…</country>
     <roundtime>50</roundtime> <finalsroundtime>50</finalsroundtime>
     <organizer popid="1234567" name="Alex Example"/>
     ```

     - **`<id/>` can be empty**: TOM may write a file with no tournament id. The app fills it in with the
       tournament's display id, and warns (decision 8, `tdf_tournament_id_filled`).
     - **Game type to product:** `gametype` `GO` is play-tools' `pgo`. The `TCG` and `VGC` spellings are taken from
       real files of each game before `tdf_wrong_game` is built (Q8). An unknown spelling gives no game warning
       rather than a false one.
   - **Blocks: no upload is possible**, so there is nothing to send (422, and the card says why):
     - the file can't be read safely (`too_large`, `unsafe`, `not_tdf`: the parser's existing refusals);
     - the tournament can't take an upload from the organizer, from a fresh read as them: not sanctioned, already
       complete or holding player records (`results_already_uploaded`), past the window, or its organizer not
       connected (`results_not_accepted`, saying which). play-tools itself won't accept an organizer's upload then
       (S8), so this isn't a validation question;
     - another job holds the league's lease (`submission_running`).
   - **Warnings: the file may fail validation, and the organizer decides.** Each warning names what is wrong and
     what play-tools is likely to do:
     - **the app's own checks, against the fresh read:**
       - the file's tournament id is **empty**: the app **fills it in** and warns (decision 8,
         `tdf_tournament_id_filled`);
       - the file's tournament id is **set but different** from the card's display id (`tdf_wrong_tournament`). This
         is a warning only, and the app never overwrites an id TOM wrote;
       - its organizer id isn't the tournament's organizer. The app **fixes this in the file** rather than only
         warning (decision 8): `tdf_organizer_replaced`, or `tdf_wrong_organizer` when it can't;
       - its game type doesn't match the tournament's product (`tdf_wrong_game`);
       - a player in the file is on the tournament's staff, as play-tools lists it (`tdf_staff_also_playing`, naming
         them and their role). play-tools refuses this as `STAFF_PLAYERS_ERROR`. It stays a warning: the organizer
         may upload anyway. The warning offers a fix, **Remove from staff**, for each of them or for all at once
         (organizer, 2026-10-12). It works whether the staff record was added through the app or directly in
         play-tools:
         - a confirm names each person and role being removed from the tournament's staff in play-tools;
         - it starts an ordinary staff job (ADR-0007), as the tournament's organizer. The job re-reads the records and
           deletes only that player's staff record on this tournament, and only if it still lists them as staff;
         - their staff assignment in the app, if any, is removed, and so is the tournament's `STAFF_HISTORY` row for
           them, since they played rather than staffed;
         - when the job ends, the preview re-runs play-tools' validate from the archived file (ADR-0012), so the
           warnings shown are current.

         The organizer's own `organizer` record is never removed: a TDF listing the organizer as a player is a
         warning with no fix.
     - **play-tools' own validation:** every error its validate call returns, mapped to readable messages by an
       adapter constant (the S8 table), and an unknown code shown as is.
     - **Players new to the app** (`tdf_unknown_players`): every player id in the file that the app has never seen
       (no `PLAYER` row), listed with the name the file gives. The list is headed "Not in the app yet. Check these ids
       weren't mis-keyed in TOM". When a known player has the same name (ignoring case and spacing) under another id,
       the row says "A known player with this name has id 01234". It is a hint only. The app never changes an id in
       the file. A mis-keyed id is fixed in TOM, and the file is dropped again. The list is worked out before the
       attendance import would make these players known.
   - **Then upstream's validate** runs as the organizer, in one call, whenever nothing blocks. It validates **the
     file that would be sent**, with the organizer already replaced (decision 8). It runs even with local warnings, so
     the organizer sees play-tools' own answer before choosing. It returns `upload_guid` and play-tools' errors. It
     waits only while the organizer's full name is still being asked for (decision 8).
   - **The preview is stored:** the file goes into the encrypted TDF archive (ADR-0012), and a
     `tournament_result_upload` row holds the tournament, the archived file's id, SHA-256, player count,
     `upload_guid`, the warnings (codes, messages and the unknown players' ids and names) and state `previewed`.
     The attendance side's pending `TDF_UPLOAD` points at the same archived file. Unconfirmed previews, and a file
     nothing else keeps, are dropped after a day.

4. **Confirm** (`POST …/results/{uploadId}/confirm {importAttendance, acknowledgeWarnings}`) starts a
   `kind = 'tdf_upload'` job on the submission rails (lease, History, retry, recovery):
   - **Warn before sending.** A replaced organizer is listed first: "The file names <popid> (<name>) as organizer.
     It will be sent with <full name> (<player id>), the tournament's organizer, instead." It counts as a warning to
     acknowledge, and the button reads **Replace organizer and upload** when it is the only one. With no warnings,
     the button is **Upload results**. With any warning, the dialog lists
     them all, play-tools' first, and the button becomes **Upload anyway**. The dialog says: "play-tools reported
     problems with this file. Uploading anyway will most likely fail processing, and Pokémon support usually has to
     resolve it." The server refuses a confirm without `acknowledgeWarnings: true` for a preview that has warnings
     (422 `warnings_not_acknowledged`), so a stale page or a script can't skip the warning. Who acknowledged it, and
     when, is stored on the upload and shown in History.
   - It re-reads the tournament as the organizer. A tournament that can no longer take an upload stops the job before
     the call (an upload made meanwhile in play-tools shows as `results_already_uploaded`).
   - It sends `PUT triumph/{upload_guid}/confirm/`. **Only the `upload_guid` travels**, so confirm and its retries
     never need the file again.
     - play-tools' own page offers Confirm only when validation found nothing, so it may refuse to confirm an upload
       with errors (S8 part 2, Q4). If it does, the outcome is `refused`, with its message and correlation id.
       Nothing else is sent.
   - If ticked, it commits the attendance import (M3 commit, idempotent). This happens even when the results upload is
     refused or fails processing, because attendance doesn't depend on play-tools accepting the results.
   - Then it reads the tournament every 15 s, for up to `NUXT_TDF_SETTLE_MS` (10 min), until it is `complete`
     (`uploaded`) or `upload_failed` (`processing_failed`). If it is still processing at the end, the job ends
     `processing` and the card keeps showing play-tools' state on every read.
   - After a 5xx on confirm it re-reads before anything else. A tournament already `upload_in_progress` or
     `complete` means the confirm landed, and it is never sent again.
   - **Support details.** A refused, failed or acknowledged-with-warnings upload shows a copyable block for Pokémon
     support: the tournament's display id and name, the date, the upload id (`upload_guid`), play-tools' error codes,
     the correlation id of any refusal, and when it was sent. Player names and the file itself are not in it.

5. **The file is kept, encrypted** (ADR-0012, replacing "the raw file only passes through"). It is stored once
   in the TDF archive, AES-256-GCM with its own key, and decrypted only in memory. It is base64-encoded into
   upstream's validate call from memory. If play-tools has forgotten the `upload_guid` by confirm time, or a retry
   needs it, the job validates again **from the archive**, so the organizer never drops the file twice. If the new
   validation has warnings the earlier acknowledgment didn't cover, the job stops and asks again. The SHA-256
   recognises the same file dropped again. The adapter never logs request bodies, and `payload` joins the redaction
   list.

6. **Not uploading twice.** The app refuses an upload for a tournament with player records (upstream allows it only
   to admins). A second preview of the same file for the same tournament reuses the open preview.

8. **Fill in an empty tournament id** (organizer, 2026-10-12). When the file's `<data><id/>` is empty (`<id/>`,
   `<id></id>` or only whitespace), the app writes the tournament's display id into it, as `<id>XX-XX-XXXXXX</id>`:
   - **Warn, to be cautious.** The warning reads: "The TDF's tournament id is empty. It will be sent with this
     tournament's id, <display id>. Check that this file is for <tournament name> on <date>." It is acknowledged like
     every warning (decision 4), and the button reads **Fill in id and upload** when it is the only one.
   - **Only when empty.** An id that is present but different is never overwritten. It stays the
     `tdf_wrong_tournament` warning, for the organizer to check.
   - **Only a well-formed id.** The display id must match `^\d{2}-\d{2}-\d{6}$`. Otherwise nothing is filled in,
     and the warning says the file has no id and play-tools will likely refuse it.
   - **The same kind of edit as the organizer fix:** a minimal text edit of that one element by the same pure
     function in `shared/tdf` (now `correctTdf(xml, {tournamentId?, organizer?})`). Every other byte is unchanged,
     the result is parsed again to check it, play-tools validates the corrected file, and only the corrected file is
     kept (below and ADR-0012). The upload records `tournament_id_filled`.

   **Fix the organizer in the file** (organizer, 2026-10-12). When the file's organizer player id (`organizer@popid`,
   compared as text) isn't the tournament's organizer (`organizer.player_id` from the fresh read), the app replaces
   it, so nobody has to edit the file in a text editor:
   - **What changes:** only the two attribute values of the `<organizer popid="…" name="…"/>` element inside
     `<data>` (the shape above): `popid`, set to the tournament organizer's player id, and `name`. The file's incorrect organizer name is **replaced too**, with the tournament organizer's full name as
     play-tools has it (organizer, 2026-10-12), confirmed once and saved (below). It is a minimal text edit by a pure function in `shared/tdf`
     (`correctTdf(xml, {organizer: {playerId, name}})`, as above). The name is XML-escaped, every other byte of the file stays as TOM
     wrote it (no re-serialising), and the result is parsed again to check it. If the file has no single
     `<organizer>` element to edit, nothing is changed, and the old warning `tdf_wrong_organizer` stands, with
     **Upload anyway** as before.
   - **The organizer's full name.** The name written into the file is the tournament organizer's full name as
     play-tools has it. The tournament details carry `organizer.first_name` and `last_name` (seen in the #67 spike
     data), and `getTournament` gains `organizerName` for it. It is stored on the professor's Pokémon connection, like
     the display name (`professor_full_name`, ≤ 100 characters), set in Settings beside the display name, or here:
     - **known:** the preview replaces the organizer straight away, and validates the corrected file;
     - **not known yet:** the preview holds the dropped file in the archive as a pending preview, skips validate,
       and answers `needsOrganizerFullName: {playerId,
       playToolsName}`. The dialog asks "<organizer>'s full name, as it should appear in the TDF", **pre-filled with
       play-tools' name** (first and last). The organizer confirms it, or corrects it once. `POST
       …/results/{uploadId}/organizer {fullName}` saves it on the connection for next time, then replaces the
       organizer and validates, and the preview carries on as usual;
     - **saved, not re-read:** once saved, the stored full name is what later files get. A change of name in
       play-tools doesn't overwrite it, as for every name in the app (ADR-0007 decision 13). It is changed in
       Settings.
   - **Acknowledged, like a warning** (decision 4): `tdf_organizer_replaced` names the old popid and name, and the
     new ones.
   - **Only the corrected file is kept** in the encrypted archive (organizer, 2026-10-12; ADR-0012). It is the file
     that was validated and sent, so the archive holds exactly what play-tools received. The dropped original is
     deleted as soon as the corrected file replaces it. Only the original's SHA-256 stays on the upload row, so the
     same file dropped again is still recognised. The `tdf_organizer_replaced` record (old and new popid and name)
     and `tournament_id_filled` say what was changed. This applies to either correction or both. The attendance import reads the corrected file, whose players are the same.
   - **Only the organizer and an empty id.** The app never rewrites anything else in a TDF. Player ids, names, a
     tournament id that is present but different, and the game type stay as warnings for the organizer to fix in
     TOM.

9. **Ports.** `PlayToolsGateway` gains `validateResults(displayId, file)` → `{uploadId, errors}` and
   `confirmResults(uploadId, tournament)`. `getTournament` gains `applicationState`, `activityState`, `organizerName` (first + last) and
   `displayId`. Which id confirm takes (the `guid` or the `display_id`; the bundle uses both) and the
   presigned-URL flag are S8 part 2's to settle, inside the adapter.

## Consequences

- (+) The TDF is dropped once a night, for attendance and results.
- (+) The common mistakes (wrong file, wrong tournament, a staffer who played, a mis-keyed id) are pointed out
  before anything is committed, in words the organizer can act on.
- (+) The organizer keeps the final say. A file that will fail validation can still go through when that is what
  they want, after an explicit warning, with the warnings and support details on record for Pokémon support.
- (+) Confirm is a job with History and retry, and it needs no stored file.
- (+) The file is kept for bookkeeping, encrypted at rest with its own key (ADR-0012). Nothing with birthdates is
  kept in the clear.
- (−) The preview makes an upstream call (validate), so it takes the league's lease briefly and fails while a job
  runs.
- (+) A restart, or an expired `upload_guid` (unknown lifetime, S8 part 2), is recovered by validating again from
  the archive, with no new drop.
- (−) A mistaken confirm can't be undone by the organizer (admin purge only). That is upstream's rule, and the
  confirm dialog says so.
- (−) An **Upload anyway** can leave a tournament `upload_failed` until Pokémon support resolves it. That is the
  organizer's informed choice, recorded with who acknowledged which warnings.
- (−) "New to the app" is only a hint. A real first-timer is listed too, and a mis-keyed id that happens to be another
  known player's id isn't caught.
- (+) A TDF naming the wrong organizer no longer means editing XML by hand. The app fixes it, says so, and keeps
  the corrected file that play-tools received.
- (−) The app now edits a file before sending it to play-tools. The edit is limited to the organizer element, tested
  as a pure function, re-parsed and acknowledged by the organizer. The original isn't kept, so only the record of
  the old popid and name shows what TOM wrote.
- (−) The parser now reads three more fields from the file (tournament id, organizer id, game type). None is personal
  data beyond a professor's player id.

## Open questions

| #  | Question | Status |
| -- | -------- | ------ |
| Q1 | Validate response shape, the shape of `errors`, confirm's id (`guid` or `display_id`), size limit, `triumph-scalability` flag | **Open: S8 part 2**, from a real upload the organizer was going to make anyway |
| Q2 | Can an upload be made before the start date? How long does `upload_in_progress` last? How long does an unconfirmed `upload_guid` live? | **Open: S8 part 2** |
| Q3 | Should the attendance import be ticked by default when a TDF is dropped on a tournament card? | **Answered (organizer, 2026-10-12):** yes, ticked |
| Q4 | Does `PUT triumph/{upload_guid}/confirm/` accept an upload whose validation returned errors, or refuse it? | **Open: S8 part 2.** Either way the app warns first; a refusal is recorded with support details (decision 4) |
| Q6 | Exact shape of TOM's `<organizer>` element | **Answered (organizer, 2026-10-12):** `<organizer popid="…" name="…"/>` inside `<data>` (decision 3). Parser fixtures use made-up values |
| Q7 | Should the app also fill in an empty `<id/>` with the tournament's display id, like it fixes the organizer? | **Answered (organizer, 2026-10-12):** yes, with a cautionary warning; only when empty (decision 8) |
| Q8 | `gametype` spellings for TCG and VGC files | **Open:** from a real file of each game; `GO` → `pgo` is known |
| Q5 | May a file that fails validation be sent at all? | **Answered (organizer, 2026-10-12):** yes, after a warning; Pokémon support resolves it from there. Players new to the app are called out as possible mis-keyed ids |
