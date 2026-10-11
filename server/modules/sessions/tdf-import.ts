import { createHash } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { type TdfInvalidRow, type TdfTournament, parseTdf } from '../../../shared/tdf/parse';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { sessionPlayer, tdfUpload, tdfUploadPlayer } from '../../db/schema';
import type { SightingsService } from '../metrics/sightings';
import type { RosterService } from '../roster/service';
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

export class UploadNotFoundError extends Error {
  override name = 'UploadNotFoundError';
  constructor(uploadId: number) {
    super(`TDF upload ${uploadId} was not found for this date. Upload the file again.`);
  }
}

export interface TdfImportService {
  /**
   * Parses the file and holds its players (name and ID only) for `commit`.
   * Changes nothing else. The same file for the same date returns the same upload.
   * @throws TdfError
   */
  preview(leagueId: string, date: SessionDate, file: { filename: string; content: string }): TdfPreview;
  /**
   * Records the file's players as known, lists the non-regulars for the date
   * and logs a `tdf` sighting for every player, regulars included.
   * Classifies against the state at commit time. A second commit is a no-op.
   * @throws UploadNotFoundError
   */
  commit(leagueId: string, date: SessionDate, uploadId: number): TdfCommitResult;
}

/** Previews that are never committed are dropped after this long. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export function createTdfImportService(deps: {
  db: Db;
  roster: RosterService;
  sightings: SightingsService;
  now?: () => Date;
}): TdfImportService {
  const { db, roster, sightings, now = () => new Date() } = deps;
  const drafts = createDrafts(db);

  const uploadPlayers = (uploadId: number) =>
    db
      .select({ playerId: tdfUploadPlayer.playerId, name: tdfUploadPlayer.name })
      .from(tdfUploadPlayer)
      .where(eq(tdfUploadPlayer.uploadId, uploadId))
      .all() as { playerId: PlayerId; name: string }[];

  const listedIds = (draftId: number) =>
    new Set(
      db
        .select({ playerId: sessionPlayer.playerId })
        .from(sessionPlayer)
        .where(eq(sessionPlayer.draftId, draftId))
        .all()
        .map((r) => r.playerId),
    );

  return {
    preview(leagueId, date, { filename, content }) {
      const parsed = parseTdf(content);
      const sha256 = createHash('sha256').update(content).digest('hex');

      return db.transaction(() => {
        db.delete(tdfUpload)
          .where(and(eq(tdfUpload.status, 'pending'), lt(tdfUpload.createdAt, new Date(now().getTime() - PENDING_TTL_MS))))
          .run();

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
              tournamentName: parsed.tournament.name,
              tournamentDate: parsed.tournament.date,
              playerCount: parsed.players.length,
              createdAt: now(),
            })
            .returning()
            .get();
          db.insert(tdfUploadPlayer)
            .values(parsed.players.map((p) => ({ uploadId: upload!.id, playerId: p.playerId, name: p.name })))
            .run();
        }

        const known = new Map(roster.getPlayers(leagueId, parsed.players.map((p) => p.playerId)).map((p) => [p.playerId, p]));
        const listed = listedIds(draft.id);
        const players = parsed.players.map((p) => {
          const onFile = known.get(p.playerId);
          const status: TdfPlayerStatus = onFile?.isRegular
            ? 'regular'
            : listed.has(p.playerId)
              ? 'listed'
              : onFile
                ? 'known'
                : 'new';
          return { playerId: p.playerId, name: onFile?.displayName || p.name, status };
        });
        const tally = (s: TdfPlayerStatus) => players.filter((p) => p.status === s).length;

        return {
          uploadId: upload.id,
          filename,
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
      });
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

        const players = uploadPlayers(upload.id);
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

        return { added, alreadyListed: toList.length - added, regulars: players.length - toList.length, alreadyImported: false };
      });
    },
  };
}

// Well under SQLite's bound-parameter limit for multi-row statements.
const CHUNK = 300;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

