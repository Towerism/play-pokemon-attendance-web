import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { and, desc, eq, lt } from 'drizzle-orm';
import { parseTdf } from '../../../shared/tdf/parse';
import type { Db } from '../../db/client';
import { tdfFile } from '../../db/schema';
import type { Logger } from '../../logging/types';
import { type Vault, VaultError } from '../vault/vault';
import { TdfFileNotFoundError, TdfKeyMismatchError } from './errors';

export type TdfKeptReason = 'attendance' | 'results';
export type TdfFileReferenceKind = 'attendance' | 'results';

export interface TdfFileSummary {
  id: number;
  filename: string;
  tournamentName: string | null;
  tournamentDate: string | null;
  /** The file's `data/id`. */
  tournamentId: string | null;
  /** UTF-8 bytes before compression. */
  byteSize: number;
  keptFor: TdfKeptReason[];
  createdBy: string;
  createdAt: Date;
}

export interface TdfFileReference {
  kind: TdfFileReferenceKind;
  id: number;
}

/**
 * A module whose rows point at archived files (`sessions` for attendance imports, `tournaments` for
 * results uploads). The archive learns about references only through these, never from their tables.
 */
export interface TdfFileReferrer {
  kind: TdfFileReferenceKind;
  /** Ids of this module's rows that point at the file. */
  referencing(fileId: number): number[];
  /** Points this module's rows at another file. Absent when the rows must keep their file (results uploads). */
  repoint?(fromFileId: number, toFileId: number): void;
}

interface NewFile {
  filename: string;
  content: string;
  /** Username of the organizer who dropped it. */
  by: string;
}

/**
 * The encrypted TDF archive (ADR-0012). Every `.tdf` the organizer drops is kept whole, gzip-compressed
 * and sealed with the TDF key, and is opened only in memory. Nothing else touches `tdf_file` or the key.
 */
export interface TdfArchiveService {
  /**
   * Keeps the file, deduplicated per league by its SHA-256.
   * @throws TdfError when the parser refuses it; nothing is stored.
   */
  store(leagueId: string, file: NewFile): { fileId: number; sha256: string; alreadyStored: boolean };
  /** @throws TdfFileNotFoundError, TdfKeyMismatchError */
  read(leagueId: string, fileId: number): { filename: string; content: string };
  /** Newest first, never the content. */
  list(leagueId: string, filter?: { tournamentId?: string; date?: string }): TdfFileSummary[];
  /** Adds `reason` to the file's kept-for set; a kept file never expires. */
  markKept(fileId: number, reason: TdfKeptReason): void;
  /**
   * Stores the corrected file in the original's place: re-points every row that can be re-pointed and
   * deletes the original unless something still points at it, in one transaction.
   * @throws TdfFileNotFoundError, TdfError
   */
  replace(leagueId: string, originalId: number, corrected: NewFile): { fileId: number };
  /**
   * The organizer's delete: the ciphertext goes at once, and the rows that pointed at it are reported.
   * @throws TdfFileNotFoundError
   */
  delete(leagueId: string, fileId: number): { referencedBy: TdfFileReference[] };
  /** Deletes files only previewed more than a day ago that nothing points at. */
  expire(): { deleted: number };
}

/** Previewed files that are never kept are deleted after this long. */
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export function createTdfArchiveService(deps: {
  db: Db;
  vault: Vault;
  /** Resolved on each use, so referrers can be wired after the archive. */
  referrers: () => TdfFileReferrer[];
  log: Logger;
  now?: () => Date;
}): TdfArchiveService {
  const { db, vault, referrers, log, now = () => new Date() } = deps;

  const aad = (leagueId: string, sha256: string) => `tdf_file:${leagueId}:${sha256}`;

  const find = (leagueId: string, fileId: number) => {
    const row = db
      .select()
      .from(tdfFile)
      .where(and(eq(tdfFile.id, fileId), eq(tdfFile.leagueId, leagueId)))
      .get();
    if (!row) throw new TdfFileNotFoundError(fileId);
    return row;
  };

  const referencesTo = (fileId: number): TdfFileReference[] =>
    referrers().flatMap((r) => r.referencing(fileId).map((id) => ({ kind: r.kind, id })));

  const keptFor = (json: string) => JSON.parse(json) as TdfKeptReason[];

  const addKept = (fileId: number, reasons: TdfKeptReason[]) => {
    const row = db.select({ keptFor: tdfFile.keptFor }).from(tdfFile).where(eq(tdfFile.id, fileId)).get();
    if (!row) return;
    const merged = [...new Set([...keptFor(row.keptFor), ...reasons])].sort();
    db.update(tdfFile).set({ keptFor: JSON.stringify(merged) }).where(eq(tdfFile.id, fileId)).run();
  };

  const store: TdfArchiveService['store'] = (leagueId, { filename, content, by }) => {
    const parsed = parseTdf(content);
    const plaintext = Buffer.from(content, 'utf8');
    const sha256 = createHash('sha256').update(plaintext).digest('hex');

    return db.transaction(() => {
      const existing = db
        .select({ id: tdfFile.id })
        .from(tdfFile)
        .where(and(eq(tdfFile.leagueId, leagueId), eq(tdfFile.sha256, sha256)))
        .get();
      if (existing) return { fileId: existing.id, sha256, alreadyStored: true };

      const { id } = db
        .insert(tdfFile)
        .values({
          leagueId,
          sha256,
          filename,
          byteSize: plaintext.length,
          ciphertext: vault.seal(gzipSync(plaintext), aad(leagueId, sha256)),
          tournamentName: parsed.tournament.name,
          tournamentDate: parsed.tournament.date,
          tournamentDisplayId: parsed.header.tournamentId,
          createdBy: by,
          createdAt: now(),
        })
        .returning({ id: tdfFile.id })
        .get();
      return { fileId: id, sha256, alreadyStored: false };
    });
  };

  return {
    store,

    read(leagueId, fileId) {
      const row = find(leagueId, fileId);
      try {
        const content = gunzipSync(vault.open(row.ciphertext, aad(leagueId, row.sha256))).toString('utf8');
        return { filename: row.filename, content };
      } catch (err) {
        if (!(err instanceof VaultError)) throw err;
        log.warn('A stored TDF could not be opened (wrong key or tampered).', { fileId });
        throw new TdfKeyMismatchError(fileId);
      }
    },

    list(leagueId, filter = {}) {
      return db
        .select({
          id: tdfFile.id,
          filename: tdfFile.filename,
          tournamentName: tdfFile.tournamentName,
          tournamentDate: tdfFile.tournamentDate,
          tournamentId: tdfFile.tournamentDisplayId,
          byteSize: tdfFile.byteSize,
          keptFor: tdfFile.keptFor,
          createdBy: tdfFile.createdBy,
          createdAt: tdfFile.createdAt,
        })
        .from(tdfFile)
        .where(
          and(
            eq(tdfFile.leagueId, leagueId),
            filter.tournamentId === undefined ? undefined : eq(tdfFile.tournamentDisplayId, filter.tournamentId),
            filter.date === undefined ? undefined : eq(tdfFile.tournamentDate, filter.date),
          ),
        )
        .orderBy(desc(tdfFile.createdAt), desc(tdfFile.id))
        .all()
        .map((row) => ({ ...row, keptFor: keptFor(row.keptFor) }));
    },

    markKept(fileId, reason) {
      db.transaction(() => addKept(fileId, [reason]));
    },

    replace(leagueId, originalId, corrected) {
      return db.transaction(() => {
        const original = find(leagueId, originalId);
        const { fileId } = store(leagueId, corrected);
        if (fileId === originalId) return { fileId };

        addKept(fileId, keptFor(original.keptFor));
        for (const r of referrers()) r.repoint?.(originalId, fileId);
        if (referencesTo(originalId).length === 0) db.delete(tdfFile).where(eq(tdfFile.id, originalId)).run();
        return { fileId };
      });
    },

    delete(leagueId, fileId) {
      return db.transaction(() => {
        find(leagueId, fileId);
        const referencedBy = referencesTo(fileId);
        db.delete(tdfFile).where(eq(tdfFile.id, fileId)).run();
        return { referencedBy };
      });
    },

    expire() {
      return db.transaction(() => {
        const cutoff = new Date(now().getTime() - PREVIEW_TTL_MS);
        const candidates = db
          .select({ id: tdfFile.id })
          .from(tdfFile)
          .where(and(eq(tdfFile.keptFor, '[]'), lt(tdfFile.createdAt, cutoff)))
          .all()
          .filter(({ id }) => referencesTo(id).length === 0);
        for (const { id } of candidates) db.delete(tdfFile).where(eq(tdfFile.id, id)).run();
        return { deleted: candidates.length };
      });
    },
  };
}
