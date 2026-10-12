# ADR-0011: Upload a tournament's TDF to play-tools from its This week card

- Status: Proposed (M9)
- Date: 2026-10-12
- Amends: architecture §5 "TDF privacy" and §9 (the raw TDF now travels on to play-tools)
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

Two rules from §9 bear on this: **never persist raw TDF files or birthdates**, and **act on a tournament only as its
organizer** (ADR-0009). A TDF holds every player's birthdate, and play-tools needs the whole file.

## Options considered

1. **Keep uploading in play-tools.** Zero risk, and the second drop of the same file stays.
2. **One call on drop:** validate and confirm at once. This skips the moment where upstream's validation errors can
   be read before anything is committed, and confirm is irreversible for an organizer.
3. **Preview → confirm, mirroring upstream's two phases.** Drop the file, and the app checks it locally and through
   upstream's validate, showing both. **Upload results** then confirms, as a job.
4. **Keep the file and upload later**, for example in a queue that survives a restart. It needs the raw file stored,
   which §9 forbids.

## Decision

Option 3.

1. **Where.** Each This week tournament card (ADR-0010 decision 10) gets a **Results** section under Staff, showing
   the tournament's upload state from play-tools: *Awaiting results*, *Processing*, *Complete*, *Upload failed*, or
   why an upload isn't possible (not sanctioned yet, organizer not connected, past the window, players already
   recorded).

2. **One drop, both jobs.** Dropping a `.tdf` on a card previews **both** the results upload and the attendance
   import (M3) for that date. The attendance import is ticked by default, and the organizer can untick it. The
   page's own TDF dropzone stays for dates whose tournament isn't in play-tools.

3. **Preview** (`POST /sessions/{date}/tournaments/{tournamentId}/results`, the file's text as JSON, ≤ 2 MB):
   - **Parsed locally first** with `shared/tdf`, which learns to read the file's tournament id (`data/id`), its
     organizer's player id (`organizer@popid`) and game type, besides names and ids. It still never reads
     birthdates.
   - **Checked locally against a fresh read**, as the organizer, before upstream sees the file:
     - the file's tournament id equals the card's display id (`tdf_wrong_tournament`);
     - its organizer id equals the tournament's organizer (`tdf_wrong_organizer`);
     - the tournament can take an upload: sanctioned, `pending`, within the window, no player records
       (`results_not_accepted`, with which condition failed; `results_already_uploaded` when players exist);
     - no player in the file is on the tournament's staff, as play-tools lists it (`tdf_staff_also_playing`, naming
       them). This catches `STAFF_PLAYERS_ERROR` with a readable answer, and points at the Staff section to fix it.
   - **Then upstream's validate**, as the organizer, one call, refused while another job holds the league's lease
     (`submission_running`). It returns `upload_guid` and play-tools' errors, mapped to readable messages by an
     adapter constant (the S8 table). An unknown code is shown as is.
   - **The preview is stored without the file:** a `tournament_result_upload` row with the tournament, file name,
     SHA-256, player count, `upload_guid`, upstream errors and state `previewed`. The attendance side creates its
     usual pending `TDF_UPLOAD` (name and id only). Unconfirmed previews are dropped after a day, like TDF previews.

4. **Confirm** (`POST …/results/{uploadId}/confirm {importAttendance}`) starts a `kind = 'tdf_upload'` job on the
   submission rails (lease, History, retry, recovery):
   - It re-reads the tournament as the organizer. A tournament no longer accepting an upload stops the job before
     the call (an upload made meanwhile in play-tools shows as `results_already_uploaded`).
   - It sends `PUT triumph/{upload_guid}/confirm/`. **Only the `upload_guid` travels**, so confirm and its retries
     never need the file again.
   - If ticked, it commits the attendance import (M3 commit, idempotent).
   - Then it reads the tournament every 15 s, for up to `NUXT_TDF_SETTLE_MS` (10 min), until it is `complete`
     (`uploaded`) or `upload_failed` (`processing_failed`). If it is still processing at the end, the job ends
     `processing` and the card keeps showing play-tools' state on every read.
   - After a 5xx on confirm it re-reads before anything else. A tournament already `upload_in_progress` or
     `complete` means the confirm landed, and it is never sent again.

5. **The raw file only passes through.** It lives in the preview request's memory, is base64-encoded straight into
   upstream's validate call, and is never written to the database, disk or logs. Only its SHA-256 is kept, so the
   same file dropped again is recognised. play-tools is the file's intended destination, as when the organizer
   uploads it there. The adapter never logs request bodies, and `payload` joins the redaction list.

6. **Not uploading twice.** The app refuses an upload for a tournament with player records (upstream allows it only
   to admins). A second preview of the same file for the same tournament reuses the open preview.

7. **Ports.** `PlayToolsGateway` gains `validateResults(displayId, file)` → `{uploadId, errors}` and
   `confirmResults(uploadId, tournament)`. `getTournament` gains `applicationState`, `activityState` and
   `displayId`. Which id confirm takes (the `guid` or the `display_id`; the bundle uses both) and the
   presigned-URL flag are S8 part 2's to settle, inside the adapter.

## Consequences

- (+) The TDF is dropped once a night, for attendance and results.
- (+) The common mistakes (wrong file, wrong tournament, a staffer who played) are caught before play-tools sees the
  file, in words the organizer can act on.
- (+) Confirm is a job with History and retry, and it needs no stored file.
- (+) The raw-file rule holds: nothing with birthdates is kept.
- (−) The preview makes an upstream call (validate), so it takes the league's lease briefly and fails while a job
  runs.
- (−) A restart between preview and confirm keeps the `upload_guid`, but if upstream expires it (unknown, S8 part
  2), the organizer drops the file again.
- (−) A mistaken confirm can't be undone by the organizer (admin purge only). That is upstream's rule, and the
  confirm dialog says so.
- (−) The parser now reads three more fields from the file (tournament id, organizer id, game type). None is personal
  data beyond a professor's player id.

## Open questions

| #  | Question | Status |
| -- | -------- | ------ |
| Q1 | Validate response shape, the shape of `errors`, confirm's id (`guid` or `display_id`), size limit, `triumph-scalability` flag | **Open: S8 part 2**, from a real upload the organizer was going to make anyway |
| Q2 | Can an upload be made before the start date? How long does `upload_in_progress` last? How long does an unconfirmed `upload_guid` live? | **Open: S8 part 2** |
| Q3 | Should the attendance import be ticked by default when a TDF is dropped on a tournament card? | **Open: organizer.** Designed as ticked |
