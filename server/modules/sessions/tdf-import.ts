import { and, eq, isNull, lt } from 'drizzle-orm';
import { type ParsedTdf, type TdfInvalidRow, type TdfTournament, parseTdf } from '../../../shared/tdf/parse';
import type { SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { sessionPlayer, tdfUpload } from '../../db/schema';
import type { SightingsService } from '../metrics/sightings';
import type { RosterService } from '../roster/service';
import type { TdfArchiveService, TdfFileReferrer } from '../tdf-archive/service';
import { createDrafts } from './drafts';

/** How a TDF player relates to the league and the date, as of the preview. */
export type TdfPlayerStatus = 'new' | 'known' | 'regular' | 'listed';

export interface TdfPreview {
  uploadId: number;
  filename: string;
  tournament: TdfTournament;
  /** The same file was already committed for this date; committing again changes nothing. */
  alreadyImported: boolean;
  counts: Record<'new' | 'known' | 'regulars' | 'listed' | 'invalid' | 'duplicates', number>;
  players: { playerId: PlayerId; name: string; status: TdfPlayerStatus }[];
  invalid: TdfInvalidRow[];
}

export interface TdfCommitResult {
  /** Newly listed as session players. */
  added: number;
  /** Non-regulars who were already listed for the date. */
  alreadyListed: number;
  /** In the file but submitted every session anyway; they still get a sighting. */
  regulars: number;
  /** The upload had been committed before, so nothing changed. */
  alreadyImported: boolean;
}

/** The organizer deleted the upload's archived file before it was committed. */
export class TdfFileDeletedError extends Error {
  override name = 'TdfFileDeletedError';
  constructor(uploadId: number) {
    super(`The file for TDF upload ${uploadId} was deleted. Drop it again to import it.`);
  }
}

export class UploadNotFoundError extends Error {
  override name = 'UploadNotFoundError';
  constructor(uploadId: number) {
    super(`TDF upload ${uploadId} was not found for this date. Upload the file again.`);
  }
}

export interface TdfImportService {
  /**
   * Parses the file and keeps it in the encrypted archive for `commit` (ADR-0012).
   * Changes nothing else. The same file for the same date returns the same upload.
   * @throws TdfError
   */
  preview(leagueId: string, date: SessionDate, file: { filename: string; content: string; by: string }): TdfPreview;
  /**
   * Parses the archived file again, records its players as known, lists the
   * non-regulars for the date and logs a `tdf` sighting for every player,
   * regulars included, then keeps the file for attendance.
   * Classifies against the state at commit time. A second commit is a no-op.
   * @throws UploadNotFoundError, TdfFileDeletedError, TdfKeyMismatchError
   */
  commit(leagueId: string, date: SessionDate, uploadId: number): TdfCommitResult;
  /**
   * The import as it stands, classified against the league now, from its archived file: what a TDF results upload
   * (#96) shows on a recheck without previewing the corrected file again. Null when the import, or its file, is gone.
   */
  view(leagueId: string, date: SessionDate, uploadId: number): TdfPreview | null;
  /** Drops previews never committed within a day, then the archived files nothing uses any more. */
  expirePreviews(): { uploads: number; files: number };
}

/** The archive's view of the attendance imports that point at its files. */
export function createTdfUploadReferrer(db: Db): TdfFileReferrer {
  return {
    kind: 'attendance',
    referencing: (fileId) =>
      db
        .select({ id: tdfUpload.id })
        .from(tdfUpload)
        .where(eq(tdfUpload.tdfFileId, fileId))
        .all()
        .map((r) => r.id),
    repoint(fromFileId, toFileId) {
      db.update(tdfUpload).set({ tdfFileId: toFileId }).where(eq(tdfUpload.tdfFileId, fromFileId)).run();
    },
  };
}

/** Previews that are never committed are dropped after this long. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export function createTdfImportService(deps: {
  db: Db;
  roster: RosterService;
  sightings: SightingsService;
  archive: TdfArchiveService;
  now?: () => Date;
}): TdfImportService {
  const { db, roster, sightings, archive, now = () => new Date() } = deps;
  const drafts = createDrafts(db);

  const expirePreviews = () =>
    db.transaction(() => {
      const uploads = db
        .delete(tdfUpload)
        .where(and(eq(tdfUpload.status, 'pending'), lt(tdfUpload.createdAt, new Date(now().getTime() - PENDING_TTL_MS))))
        .run().changes;
      return { uploads, files: archive.expire().deleted };
    });

  const listedIds = (draftId: number) =>
    new Set(
      db
        .select({ playerId: sessionPlayer.playerId })
        .from(sessionPlayer)
        .where(eq(sessionPlayer.draftId, draftId))
        .all()
        .map((r) => r.playerId),
    );

  /** Each of the file's players against the league and the date's session players, now. */
  function classify(leagueId: string, draftId: number, upload: { id: number; filename: string; status: string }, parsed: ParsedTdf): TdfPreview {
    const known = new Map(roster.getPlayers(leagueId, parsed.players.map((p) => p.playerId)).map((p) => [p.playerId, p]));
    const listed = listedIds(draftId);
    const players = parsed.players.map((p) => {
      const onFile = known.get(p.playerId);
      const status: TdfPlayerStatus = onFile?.isRegular ? 'regular' : listed.has(p.playerId) ? 'listed' : onFile ? 'known' : 'new';
      return { playerId: p.playerId, name: onFile?.displayName || p.name, status };
    });
    const tally = (s: TdfPlayerStatus) => players.filter((p) => p.status === s).length;

    return {
      uploadId: upload.id,
      filename: upload.filename,
      tournament: parsed.tournament,
      alreadyImported: upload.status === 'committed',
      counts: {
        new: tally('new'),
        known: tally('known'),
        regulars: tally('regular'),
        listed: tally('listed'),
        invalid: parsed.invalid.length,
        duplicates: parsed.duplicates,
      },
      players,
      invalid: parsed.invalid,
    };
  }

  return {
    preview(leagueId, date, { filename, content, by }) {
      const parsed = parseTdf(content);

      return db.transaction(() => {
        expirePreviews();

        const { fileId, sha256 } = archive.store(leagueId, { filename, content, by });
        const draft = drafts.ensure(leagueId, date);
        let upload = db
          .select()
          .from(tdfUpload)
          .where(and(eq(tdfUpload.draftId, draft.id), eq(tdfUpload.sha256, sha256)))
          .get();
        if (!upload) {
          upload = db
            .insert(tdfUpload)
            .values({
              draftId: draft.id,
              filename,
              sha256,
              tdfFileId: fileId,
              tournamentName: parsed.tournament.name,
              tournamentDate: parsed.tournament.date,
              playerCount: parsed.players.length,
              createdAt: now(),
            })
            .returning()
            .get();
        } else if (upload.tdfFileId === null) {
          // The organizer deleted the archived copy; the file dropped again takes its place.
          db.update(tdfUpload)
            .set({ tdfFileId: fileId })
            .where(and(eq(tdfUpload.id, upload.id), isNull(tdfUpload.tdfFileId)))
            .run();
        }

        return classify(leagueId, draft.id, { id: upload.id, filename, status: upload.status }, parsed);
      });
    },

    view(leagueId, date, uploadId) {
      const draft = drafts.find(leagueId, date);
      const upload =
        draft &&
        db
          .select()
          .from(tdfUpload)
          .where(and(eq(tdfUpload.id, uploadId), eq(tdfUpload.draftId, draft.id)))
          .get();
      if (!draft || !upload || upload.tdfFileId === null) return null;
      return classify(leagueId, draft.id, upload, parseTdf(archive.read(leagueId, upload.tdfFileId).content));
    },

    commit(leagueId, date, uploadId) {
      return db.transaction(() => {
        const draft = drafts.find(leagueId, date);
        const upload =
          draft &&
          db
            .select()
            .from(tdfUpload)
            .where(and(eq(tdfUpload.id, uploadId), eq(tdfUpload.draftId, draft.id)))
            .get();
        if (!draft || !upload) throw new UploadNotFoundError(uploadId);
        if (upload.status === 'committed') return { added: 0, alreadyListed: 0, regulars: 0, alreadyImported: true };
        if (upload.tdfFileId === null) throw new TdfFileDeletedError(uploadId);

        const { players } = parseTdf(archive.read(leagueId, upload.tdfFileId).content);
        roster.ensurePlayers(
          leagueId,
          players.map((p) => (p.name ? { playerId: p.playerId, name: p.name } : { playerId: p.playerId })),
        );
        const regulars = roster.regularIds(leagueId);
        const toList = players.filter((p) => !regulars.has(p.playerId));

        let added = 0;
        for (const chunk of chunks(toList)) {
          added += db
            .insert(sessionPlayer)
            .values(chunk.map((p) => ({ draftId: draft.id, playerId: p.playerId, source: 'tdf' as const, tdfUploadId: upload.id })))
            .onConflictDoNothing()
            .run().changes;
        }
        sightings.record(
          leagueId,
          date,
          'tdf',
          players.map((p) => p.playerId),
        );
        db.update(tdfUpload).set({ status: 'committed', committedAt: now() }).where(eq(tdfUpload.id, upload.id)).run();
        archive.markKept(upload.tdfFileId, 'attendance');

        return { added, alreadyListed: toList.length - added, regulars: players.length - toList.length, alreadyImported: false };
      });
    },

    expirePreviews,
  };
}

// Well under SQLite's bound-parameter limit for multi-row statements.
const CHUNK = 300;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

