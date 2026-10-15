import { and, desc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { ResultsConfirmBody } from '../../../shared/schemas/results';
import { correctTdf } from '../../../shared/tdf/correct';
import { warningsFingerprint } from '../../../shared/tdf/fingerprint';
import { type ParsedTdf, parseTdf } from '../../../shared/tdf/parse';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { dateIn } from '../../../shared/time/local-time';
import type { Db } from '../../db/client';
import { tournamentResultUpload } from '../../db/schema';
import type { ActingConnection, PokemonConnectionService } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { PlayToolsGateway, TournamentDetails, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import type { RosterService } from '../roster/service';
import type { TdfImportService, TdfPreview } from '../sessions/tdf-import';
import { TdfFileNotFoundError } from '../tdf-archive/errors';
import type { TdfArchiveService, TdfFileReferrer } from '../tdf-archive/service';
import { TournamentsError } from './errors';
import { type OrganizerRead, organizerReads } from './organizer';
import { type ResultsCorrections, type ResultsWarning, fingerprinted, normalName, resultsWarnings, uploadability } from './results-checks';

export type { ResultsWarning } from './results-checks';

type UploadRow = typeof tournamentResultUpload.$inferSelect;
export type UploadState = UploadRow['state'];

/** What a drop on a tournament card answers (ADR-0011 decision 3): nothing has been sent. */
export interface ResultsPreview {
  uploadId: number;
  state: 'previewed';
  tournament: { id: string; displayId: string | null; name: string | null; date: string };
  file: { filename: string; playerCount: number };
  /** The file's organizer must be replaced and their full name isn't known yet: ask, then `setOrganizerName`. */
  needsOrganizerFullName: { playerId: string; playToolsName: string | null } | null;
  warnings: ResultsWarning[];
  /** The warnings' fingerprint the confirm must carry; null while the full name is asked for. */
  fingerprint: string | null;
  /** The attendance import of the same file for the date (M3); null once that import or its file is gone. */
  attendance: TdfPreview | null;
}

export interface ResultsUploadView {
  uploadId: number;
  state: UploadState;
  filename: string;
  playerCount: number;
  warnings: ResultsWarning[];
  fingerprint: string | null;
  needsOrganizerFullName: ResultsPreview['needsOrganizerFullName'];
  /** play-tools' validation errors. */
  errors: { code: string; message: string; detail: string | null }[];
  errorCode: string | null;
  acknowledged: { by: string; at: string; fingerprint: string } | null;
  submissionId: number | null;
  fileDeleted: boolean;
  createdAt: string;
}

/** A tournament card's Results section (ADR-0011 decision 1), processing followed on this read (ADR-0011 Update #96). */
export interface ResultsSection {
  upstream:
    | { status: 'awaiting_results' | 'processing' | 'complete' | 'upload_failed' | 'results_already_uploaded' | 'results_not_accepted'; reason: string | null }
    | { error: string };
  latest: ResultsUploadView | null;
  earlier: { uploadId: number; state: UploadState; createdAt: string }[];
  /** **Download TDF** would serve a file (ADR-0012 decision 7); from local rows only. */
  tdfAvailable: boolean;
}

/** What a confirm starts a `tdf_upload` job for. */
export interface ConfirmPlan {
  uploadId: number;
  tournamentId: string;
  professorPlayerId: string;
  label: string;
  date: SessionDate;
  importAttendance: boolean;
}

/** What Remove from staff starts a removal-only staff job for, after its checks. */
export interface RemovalPlan {
  uploadId: number;
  tournamentId: string;
  professorPlayerId: string;
  label: string;
  date: SessionDate;
  playerIds: PlayerId[];
}

/** The `tdf_upload` job's fresh check just before the send. */
export type JobCheck =
  | {
      kind: 'send';
      connectionId: number;
      tournamentId: string;
      displayId: string;
      name: string | null;
      content: string;
      fileId: number;
    }
  | { kind: 'blocked'; code: string; message: string; displayId: string | null }
  | { kind: 'warnings_changed'; warnings: ResultsWarning[]; fingerprint: string; displayId: string | null };

export type UploadPatch = Partial<{
  state: UploadState;
  upstreamUploadId: string | null;
  upstreamErrors: { code: string; message: string; detail: string | null }[];
  errorCode: string | null;
}>;

export interface TournamentResults {
  /**
   * Parses, checks and stores a dropped TDF for a card's tournament (reads only: nothing is sent).
   * @throws TdfError, TournamentsError (`not_found`, `results_not_accepted`, `results_already_uploaded`, `league_not_selected`), PokemonUpstreamError
   */
  preview(leagueId: string, date: SessionDate, tournamentId: string, file: { filename: string; content: string; by: string }): Promise<ResultsPreview>;
  /** Saves the organizer's full name on their connection, then corrects the file. @throws `organizer_name_not_needed` and the preview's */
  setOrganizerName(leagueId: string, date: SessionDate, tournamentId: string, uploadId: number, fullName: string, by: string): Promise<ResultsPreview>;
  /** The checks again from the archived file (ADR-0011 Update #96): in place for an open preview, else a new attempt. */
  recheck(leagueId: string, date: SessionDate, tournamentId: string, uploadId: number, by: string): Promise<ResultsPreview>;
  /** Remove from staff's checks (#101): each id in the file, on staff, not the organizer. @throws `not_removable` */
  checkRemovable(leagueId: string, date: SessionDate, tournamentId: string, uploadId: number, playerIds: readonly PlayerId[]): Promise<RemovalPlan>;
  /** The confirm's local checks. @throws `not_found`, `upload_not_open`, `organizer_full_name_required`, `warnings_not_acknowledged` */
  prepareConfirm(leagueId: string, date: SessionDate, tournamentId: string, uploadId: number, body: ResultsConfirmBody): ConfirmPlan;
  /** In the job's insert transaction: `previewed` → `sending`, with who acknowledged what. False when it wasn't open. */
  markSending(uploadId: number, ack: { by: string; fingerprint: string; submissionId: number }): boolean;
  /** @throws PokemonUpstreamError `not_connected`, `needs_reconnect`, or the read's own: the job stops with it */
  jobCheck(leagueId: string, uploadId: number): Promise<JobCheck>;
  record(uploadId: number, patch: UploadPatch): void;
  /** The upload's state and play-tools' upload id, for a job's recovery; null when it is gone. */
  peek(uploadId: number): { state: UploadState; upstreamUploadId: string | null; errorCode: string | null } | null;
  /** The archived file is kept for results (ADR-0012 decision 5): it was sent. */
  markKept(uploadId: number): void;
  /** The attendance import of the same drop (M3 commit). @throws the import's errors */
  commitAttendance(leagueId: string, uploadId: number): void;
  /** Moves a `processing` upload on from a fresh read (ADR-0011 Update #96); any other state is returned as it is. */
  follow(leagueId: string, uploadId: number): Promise<UploadState>;
  section(leagueId: string, date: SessionDate, tournamentId: string): Promise<ResultsSection>;
  /** An open preview's checks again after Remove from staff (ADR-0011 Update #96). Best effort: never throws. */
  recheckAfterStaff(leagueId: string, uploadId: number): Promise<void>;
  /** Deletes open previews older than a day; their files then expire with the archive's run. */
  expirePreviews(): number;
  /**
   * **Download TDF** (ADR-0012 decision 7): the archived file of the tournament's latest confirmed upload that still
   * has one. Local rows and the archive only; play-tools is never asked.
   * @throws TournamentsError `no_tdf`, TdfKeyMismatchError
   */
  download(leagueId: string, tournamentId: string): { fileId: number; filename: string; content: string };
  /** The tournaments among these that **Download TDF** would serve a file for, from local rows only. */
  tdfAvailable(leagueId: string, tournamentIds: readonly string[]): Set<string>;
}

export interface ResultsDeps {
  db: Db;
  connections: Pick<PokemonConnectionService, 'getStatus' | 'listActingConnections'>;
  gateway: (connectionId: number) => Pick<PlayToolsGateway, 'getTournament' | 'listTournamentParticipants' | 'listResultsUploads'>;
  /** The professor's full name on their connection (ADR-0011 decision 8). */
  names: { fullNameOf(leagueId: string, playerId: string): string | null; saveFullName(leagueId: string, playerId: string, fullName: string): void };
  archive: Pick<TdfArchiveService, 'store' | 'read' | 'replace' | 'markKept'>;
  attendance: Pick<TdfImportService, 'preview' | 'view' | 'commit'>;
  roster: Pick<RosterService, 'getPlayers' | 'listPlayers'>;
  timeZone: string;
  now?: () => Date;
}

/** The uploads **Download TDF** may serve (ADR-0012 decision 7): confirmed, in the league, with their file still archived. */
const servable = (leagueId: string, tournamentIds: readonly string[]) =>
  and(
    eq(tournamentResultUpload.leagueId, leagueId),
    inArray(tournamentResultUpload.tournamentId, [...tournamentIds]),
    inArray(tournamentResultUpload.state, CONFIRMED),
    isNotNull(tournamentResultUpload.tdfFileId),
  );

/** Which of the tournaments **Download TDF** would serve a file for: one query, local rows only, nothing decrypted. */
export function tdfAvailableIn(db: Db, leagueId: string, tournamentIds: readonly string[]): Set<string> {
  if (tournamentIds.length === 0) return new Set();
  const rows = db.selectDistinct({ id: tournamentResultUpload.tournamentId }).from(tournamentResultUpload).where(servable(leagueId, tournamentIds)).all();
  return new Set(rows.map((r) => r.id));
}

/** The archive's view of the results uploads that point at its files: they keep their file (no re-point). */
export function createResultUploadReferrer(db: Db): TdfFileReferrer {
  return {
    kind: 'results',
    referencing: (fileId) =>
      db
        .select({ id: tournamentResultUpload.id })
        .from(tournamentResultUpload)
        .where(eq(tournamentResultUpload.tdfFileId, fileId))
        .all()
        .map((r) => r.id),
  };
}

const DISPLAY_ID = /^\d{2}-\d{2}-\d{6}$/;
/** Open previews are dropped after this long. */
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
/** Uploads play-tools confirmed (ADR-0012 decision 7): only their files are ever served by **Download TDF**. */
const CONFIRMED: UploadState[] = ['processing', 'complete'];
const NO_CORRECTIONS: ResultsCorrections = { organizerReplaced: null, tournamentIdFilled: false };

interface Located {
  read: TournamentDetails;
  organizer: ActingConnection;
  participants: TournamentParticipant[];
}

export function createTournamentResults(deps: ResultsDeps): TournamentResults {
  const { db, archive } = deps;
  const now = deps.now ?? (() => new Date());
  const reads = organizerReads(deps);

  // --- rows ------------------------------------------------------------------

  const find = (leagueId: string, date: SessionDate, tournamentId: string, uploadId: number): UploadRow => {
    const row = db
      .select()
      .from(tournamentResultUpload)
      .where(
        and(
          eq(tournamentResultUpload.id, uploadId),
          eq(tournamentResultUpload.leagueId, leagueId),
          eq(tournamentResultUpload.tournamentId, tournamentId),
          eq(tournamentResultUpload.sessionDate, date),
        ),
      )
      .get();
    if (!row) throw new TournamentsError('not_found', 'No such results upload for this tournament.');
    return row;
  };
  const byId = (uploadId: number): UploadRow | undefined => db.select().from(tournamentResultUpload).where(eq(tournamentResultUpload.id, uploadId)).get();
  const update = (uploadId: number, set: Partial<typeof tournamentResultUpload.$inferInsert>) =>
    db.update(tournamentResultUpload).set(set).where(eq(tournamentResultUpload.id, uploadId)).run();
  const correctionsOf = (row: UploadRow): ResultsCorrections => ({
    organizerReplaced: (row.organizerReplaced as ResultsCorrections['organizerReplaced']) ?? null,
    tournamentIdFilled: row.tournamentIdFilled,
  });

  // --- play-tools --------------------------------------------------------------

  /** The card's tournament, read fresh as its organizer (ADR-0011 Update #96), with everyone it lists. */
  async function locate(leagueId: string, date: string, tournamentId: string): Promise<Located> {
    const group = deps.connections.getStatus(leagueId).league?.id;
    if (!group) throw new TournamentsError('league_not_selected', 'Choose the league in Settings first.');
    let found: OrganizerRead;
    try {
      found = await reads.ofGuid(group, tournamentId);
    } catch (err) {
      if (err instanceof TournamentsError && (err.code === 'organizer_not_connected' || err.code === 'needs_reconnect')) {
        throw new TournamentsError('results_not_accepted', err.message, { ...err.details, reason: err.code });
      }
      throw err;
    }
    const { read, organizer } = found;
    if (!read.startsAt || dateIn(read.startsAt, deps.timeZone) !== date) {
      throw new TournamentsError('not_found', `This tournament isn't on ${date}.`);
    }
    const participants = await deps.gateway(organizer.id).listTournamentParticipants(tournamentId);
    return { read, organizer, participants };
  }

  function assertUploadable({ read, participants }: Located): void {
    const u = uploadability(read, participants, now());
    if (u.ok) return;
    if (u.code === 'results_already_uploaded') {
      throw new TournamentsError('results_already_uploaded', 'play-tools already has results for this tournament, or players recorded on it.');
    }
    throw new TournamentsError(
      'results_not_accepted',
      u.reason === 'window_closed' ? 'play-tools no longer takes results for this tournament (90 days after its start).' : "This tournament isn't sanctioned yet.",
      { reason: u.reason },
    );
  }

  // --- checks ----------------------------------------------------------------

  function warningsFor(leagueId: string, parsed: ParsedTdf, read: TournamentDetails, participants: readonly TournamentParticipant[], corrections: ResultsCorrections) {
    const ids = parsed.players.map((p) => p.playerId);
    const knownPlayerIds = new Set<string>(deps.roster.getPlayers(leagueId, ids).map((p) => p.playerId));
    const knownNames = new Map<string, string[]>();
    if (parsed.players.some((p) => !knownPlayerIds.has(p.playerId))) {
      for (const p of deps.roster.listPlayers(leagueId)) {
        const key = normalName(p.displayName);
        if (key) knownNames.set(key, [...(knownNames.get(key) ?? []), p.playerId]);
      }
      for (const list of knownNames.values()) list.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    }
    const warnings = resultsWarnings({
      parsed,
      tournament: {
        displayId: read.displayId,
        organizerPlayerId: read.organizerPlayerId,
        products: read.products,
        name: read.name,
        date: read.startsAt ? dateIn(read.startsAt, deps.timeZone) : null,
      },
      participants,
      knownPlayerIds,
      knownNames,
      corrections,
    });
    return { warnings, fingerprint: warningsFingerprint(fingerprinted(warnings)) };
  }

  /**
   * Fixes what ADR-0011 decision 8 lets the app fix, keeping only the corrected file (ADR-0012). Null when the
   * organizer must be replaced but their full name isn't known yet: nothing is changed then.
   */
  function correct(
    leagueId: string,
    original: { fileId: number; content: string; filename: string; by: string },
    read: TournamentDetails,
  ): { fileId: number; corrections: ResultsCorrections } | null {
    const parsed = parseTdf(original.content);
    const request: Parameters<typeof correctTdf>[1] = {};
    if (parsed.header.tournamentId === null && read.displayId && DISPLAY_ID.test(read.displayId)) request.tournamentId = read.displayId;
    let fullName: string | null = null;
    if (parsed.header.organizer && parsed.header.organizer.playerId !== read.organizerPlayerId) {
      fullName = deps.names.fullNameOf(leagueId, read.organizerPlayerId);
      if (!fullName) return null;
      request.organizer = { playerId: read.organizerPlayerId, name: fullName };
    }
    if (request.tournamentId === undefined && request.organizer === undefined) return { fileId: original.fileId, corrections: NO_CORRECTIONS };

    const result = correctTdf(original.content, request);
    const replaced = result.organizer?.applied === true ? result.organizer.previous : null;
    const corrections: ResultsCorrections = {
      organizerReplaced: replaced ? { fromPlayerId: replaced.playerId, fromName: replaced.name, toPlayerId: read.organizerPlayerId, toName: fullName! } : null,
      tournamentIdFilled: result.tournamentId?.applied === true,
    };
    if (result.xml === original.content) return { fileId: original.fileId, corrections };
    const { fileId } = archive.replace(leagueId, original.fileId, { filename: original.filename, content: result.xml, by: original.by });
    return { fileId, corrections };
  }

  function needsName(leagueId: string, located: Located, content: string): ResultsPreview['needsOrganizerFullName'] {
    const organizer = parseTdf(content).header.organizer;
    const { read } = located;
    if (!organizer || organizer.playerId === read.organizerPlayerId || deps.names.fullNameOf(leagueId, read.organizerPlayerId)) return null;
    return { playerId: read.organizerPlayerId, playToolsName: read.organizerName };
  }

  /**
   * Brings an open preview up to date from a fresh read: corrects a file still waiting for the full name once it is
   * known, then works the warnings out again, carrying the recorded corrections (ADR-0011 Update #96).
   */
  function refresh(leagueId: string, row: UploadRow, located: Located, by: string): ResultsPreview {
    if (row.tdfFileId === null) throw new TournamentsError('tdf_file_deleted', 'The file for this upload was deleted. Drop it again.');
    let { content } = archive.read(leagueId, row.tdfFileId);
    let fileId = row.tdfFileId;
    let corrections = correctionsOf(row);
    const pending = row.pendingOrganizer !== null;
    if (pending) {
      const asked = needsName(leagueId, located, content);
      if (asked) {
        update(row.id, { pendingOrganizer: asked, warnings: [], warningsFingerprint: null });
        return view(leagueId, { ...row, pendingOrganizer: asked, warnings: [], warningsFingerprint: null });
      }
      // The pending row holds the original: let it go, so the corrected copy replaces it in the archive.
      const fixed = db.transaction(() => {
        update(row.id, { tdfFileId: null });
        const out = correct(leagueId, { fileId, content, filename: row.filename, by }, located.read)!;
        update(row.id, { tdfFileId: out.fileId });
        return out;
      });
      fileId = fixed.fileId;
      corrections = fixed.corrections;
      content = archive.read(leagueId, fileId).content;
    }
    const parsed = parseTdf(content);
    const { warnings, fingerprint } = warningsFor(leagueId, parsed, located.read, located.participants, corrections);
    const set = {
      tdfFileId: fileId,
      pendingOrganizer: null,
      organizerReplaced: corrections.organizerReplaced,
      tournamentIdFilled: corrections.tournamentIdFilled,
      warnings,
      warningsFingerprint: fingerprint,
      displayId: located.read.displayId,
      tournamentName: located.read.name,
      professorPlayerId: located.read.organizerPlayerId,
      playerCount: parsed.players.length,
    };
    update(row.id, set);
    return view(leagueId, { ...row, ...set });
  }

  function view(leagueId: string, row: UploadRow): ResultsPreview {
    const pending = row.pendingOrganizer as ResultsPreview['needsOrganizerFullName'];
    return {
      uploadId: row.id,
      state: 'previewed',
      tournament: { id: row.tournamentId, displayId: row.displayId, name: row.tournamentName, date: row.sessionDate },
      file: { filename: row.filename, playerCount: row.playerCount },
      needsOrganizerFullName: pending ?? null,
      warnings: pending ? [] : (row.warnings as ResultsWarning[]),
      fingerprint: pending ? null : row.warningsFingerprint,
      attendance: row.attendanceUploadId === null ? null : safeView(leagueId, row.sessionDate as SessionDate, row.attendanceUploadId),
    };
  }

  function safeView(leagueId: string, date: SessionDate, attendanceUploadId: number): TdfPreview | null {
    try {
      return deps.attendance.view(leagueId, date, attendanceUploadId);
    } catch {
      return null;
    }
  }

  const openFor = (leagueId: string, tournamentId: string, sha256: string) =>
    db
      .select()
      .from(tournamentResultUpload)
      .where(
        and(
          eq(tournamentResultUpload.leagueId, leagueId),
          eq(tournamentResultUpload.tournamentId, tournamentId),
          eq(tournamentResultUpload.sha256, sha256),
          eq(tournamentResultUpload.state, 'previewed'),
        ),
      )
      .orderBy(desc(tournamentResultUpload.id))
      .get();

  function uploadView(row: UploadRow): ResultsUploadView {
    return {
      uploadId: row.id,
      state: row.state,
      filename: row.filename,
      playerCount: row.playerCount,
      warnings: row.warnings as ResultsWarning[],
      fingerprint: row.state === 'previewed' ? row.warningsFingerprint : null,
      needsOrganizerFullName: (row.pendingOrganizer as ResultsPreview['needsOrganizerFullName']) ?? null,
      errors: row.upstreamErrors as ResultsUploadView['errors'],
      errorCode: row.errorCode,
      acknowledged:
        row.acknowledgedBy && row.acknowledgedAt && row.acknowledgedFingerprint
          ? { by: row.acknowledgedBy, at: row.acknowledgedAt.toISOString(), fingerprint: row.acknowledgedFingerprint }
          : null,
      submissionId: row.submissionId,
      fileDeleted: row.tdfFileId === null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** The organizer a job acts as: gone or needing a reconnect stops the job. */
  function actingAs(playerId: string | null): ActingConnection {
    const c = deps.connections.listActingConnections().find((x) => x.professorPlayerId === playerId);
    if (!c) throw new PokemonUpstreamError('not_connected', `Professor ${playerId}'s Pokémon account is no longer connected.`);
    if (c.status === 'needs_reconnect') throw new PokemonUpstreamError('needs_reconnect', `Reconnect ${c.professorName ?? `Professor ${playerId}`} in Settings.`);
    return c;
  }

  async function follow(leagueId: string, uploadId: number): Promise<UploadState> {
    const row = byId(uploadId);
    if (!row || row.leagueId !== leagueId) throw new TournamentsError('not_found', 'No such results upload.');
    if (row.state !== 'processing') return row.state;
    try {
      const c = actingAs(row.professorPlayerId);
      const g = deps.gateway(c.id);
      const read = await g.getTournament(row.tournamentId);
      const settle = (state: UploadState, errorCode: string | null) => {
        update(row.id, { state, errorCode });
        return state;
      };
      if (read.activityState === 'completed') return settle('complete', null);
      if (read.activityState === 'upload_failed') return settle('failed', 'processing_failed');
      if (read.activityState === 'upload_in_progress') return 'processing';
      // Still pending: did the confirm land? play-tools' uploads list says (ADR-0011 Update #96).
      const listed = row.displayId ? (await g.listResultsUploads(row.displayId)).find((u) => u.uploadId === row.upstreamUploadId) : undefined;
      return listed?.accepted ? 'processing' : settle('failed', 'confirm_not_landed');
    } catch (err) {
      if (err instanceof PokemonUpstreamError) return row.state;
      throw err;
    }
  }

  return {
    async preview(leagueId, date, tournamentId, { filename, content, by }) {
      parseTdf(content);
      const located = await locate(leagueId, date, tournamentId);
      assertUploadable(located);
      const attendance = deps.attendance.preview(leagueId, date, { filename, content, by });
      const { fileId, sha256 } = archive.store(leagueId, { filename, content, by });

      const open = openFor(leagueId, tournamentId, sha256);
      if (open) return { ...refresh(leagueId, open, located, by), attendance };

      const asked = needsName(leagueId, located, content);
      const fixed = asked ? { fileId, corrections: NO_CORRECTIONS } : correct(leagueId, { fileId, content, filename, by }, located.read)!;
      const row = db
        .insert(tournamentResultUpload)
        .values({
          leagueId,
          tournamentId,
          displayId: located.read.displayId,
          tournamentName: located.read.name,
          sessionDate: date,
          filename,
          tdfFileId: fixed.fileId,
          sha256,
          playerCount: parseTdf(content).players.length,
          attendanceUploadId: attendance.uploadId,
          organizerReplaced: fixed.corrections.organizerReplaced,
          tournamentIdFilled: fixed.corrections.tournamentIdFilled,
          pendingOrganizer: asked,
          professorPlayerId: located.read.organizerPlayerId,
          state: 'previewed',
          createdAt: now(),
        })
        .returning()
        .get();
      return { ...refresh(leagueId, row, located, by), attendance };
    },

    async setOrganizerName(leagueId, date, tournamentId, uploadId, fullName, by) {
      const row = find(leagueId, date, tournamentId, uploadId);
      if (row.state !== 'previewed' || row.pendingOrganizer === null) {
        throw new TournamentsError('organizer_name_not_needed', "This upload isn't waiting for the organizer's full name.");
      }
      const located = await locate(leagueId, date, tournamentId);
      assertUploadable(located);
      deps.names.saveFullName(leagueId, located.read.organizerPlayerId, fullName);
      return refresh(leagueId, row, located, by);
    },

    async recheck(leagueId, date, tournamentId, uploadId, by) {
      const row = find(leagueId, date, tournamentId, uploadId);
      if (row.tdfFileId === null) throw new TournamentsError('tdf_file_deleted', 'The file for this upload was deleted. Drop it again.');
      const located = await locate(leagueId, date, tournamentId);
      assertUploadable(located);
      if (row.state === 'previewed') return refresh(leagueId, row, located, by);
      const open = openFor(leagueId, tournamentId, row.sha256);
      if (open) return refresh(leagueId, open, located, by);
      const attempt = db
        .insert(tournamentResultUpload)
        .values({
          leagueId,
          tournamentId,
          displayId: row.displayId,
          tournamentName: row.tournamentName,
          sessionDate: row.sessionDate,
          filename: row.filename,
          tdfFileId: row.tdfFileId,
          sha256: row.sha256,
          playerCount: row.playerCount,
          attendanceUploadId: row.attendanceUploadId,
          organizerReplaced: row.organizerReplaced,
          tournamentIdFilled: row.tournamentIdFilled,
          professorPlayerId: row.professorPlayerId,
          state: 'previewed',
          createdAt: now(),
        })
        .returning()
        .get();
      return refresh(leagueId, attempt, located, by);
    },

    async checkRemovable(leagueId, date, tournamentId, uploadId, playerIds) {
      const row = find(leagueId, date, tournamentId, uploadId);
      if (row.tdfFileId === null) throw new TournamentsError('tdf_file_deleted', 'The file for this upload was deleted. Drop it again.');
      const inFile = new Set<string>(parseTdf(archive.read(leagueId, row.tdfFileId).content).players.map((p) => p.playerId));
      const { read, organizer, participants } = await locate(leagueId, date, tournamentId);
      const failures: { playerId: string; reason: 'not_in_file' | 'not_staff' | 'organizer' }[] = [];
      for (const id of playerIds) {
        if (!inFile.has(id)) failures.push({ playerId: id, reason: 'not_in_file' });
        else if (id === read.organizerPlayerId) failures.push({ playerId: id, reason: 'organizer' });
        else if (!participants.some((p) => p.playerId === id && p.isStaff && p.role !== 'organizer')) failures.push({ playerId: id, reason: 'not_staff' });
      }
      if (failures.length > 0) throw new TournamentsError('not_removable', "These players can't be removed from staff.", { failures });
      return {
        uploadId: row.id,
        tournamentId,
        professorPlayerId: organizer.professorPlayerId!,
        label: [read.name ?? 'Tournament', date].join(' · '),
        date,
        playerIds: [...playerIds],
      };
    },

    prepareConfirm(leagueId, date, tournamentId, uploadId, body) {
      const row = find(leagueId, date, tournamentId, uploadId);
      if (row.state !== 'previewed') throw new TournamentsError('upload_not_open', 'This upload was already sent or closed. Use Upload again….', { state: row.state });
      if (row.pendingOrganizer !== null) {
        throw new TournamentsError('organizer_full_name_required', "Enter the organizer's full name first: the file's organizer will be replaced.");
      }
      if (body.acknowledgedWarnings !== row.warningsFingerprint) {
        throw new TournamentsError('warnings_not_acknowledged', 'The warnings changed since they were shown. Check them again before uploading.', {
          warnings: row.warnings,
          fingerprint: row.warningsFingerprint,
        });
      }
      return {
        uploadId: row.id,
        tournamentId,
        professorPlayerId: row.professorPlayerId!,
        label: [row.tournamentName ?? 'Tournament', row.sessionDate].join(' · '),
        date,
        importAttendance: body.importAttendance,
      };
    },

    markSending(uploadId, { by, fingerprint, submissionId }) {
      const changed = db
        .update(tournamentResultUpload)
        .set({ state: 'sending', acknowledgedBy: by, acknowledgedFingerprint: fingerprint, acknowledgedAt: now(), submissionId })
        .where(
          and(
            eq(tournamentResultUpload.id, uploadId),
            eq(tournamentResultUpload.state, 'previewed'),
            eq(tournamentResultUpload.warningsFingerprint, fingerprint),
          ),
        )
        .run().changes;
      return changed === 1;
    },

    async jobCheck(leagueId, uploadId) {
      const row = byId(uploadId);
      if (!row || row.leagueId !== leagueId) return { kind: 'blocked', code: 'not_found', message: 'The upload is gone.', displayId: null };
      const c = actingAs(row.professorPlayerId);
      const g = deps.gateway(c.id);
      let read: TournamentDetails;
      try {
        read = await g.getTournament(row.tournamentId);
      } catch (err) {
        if (err instanceof PokemonUpstreamError && err.code === 'not_found') {
          return { kind: 'blocked', code: 'unknown_tournament', message: 'play-tools no longer has this tournament.', displayId: row.displayId };
        }
        throw err;
      }
      const participants = await g.listTournamentParticipants(row.tournamentId);
      const u = uploadability(read, participants, now());
      if (!u.ok) {
        return {
          kind: 'blocked',
          code: u.code,
          message: u.code === 'results_already_uploaded' ? 'play-tools already has results for this tournament, or players recorded on it.' : `play-tools won't take an upload now (${u.reason}).`,
          displayId: read.displayId,
        };
      }
      if (!read.displayId) return { kind: 'blocked', code: 'no_display_id', message: 'play-tools gives this tournament no display id to upload to.', displayId: null };
      if (row.tdfFileId === null) return { kind: 'blocked', code: 'tdf_file_deleted', message: 'The file for this upload was deleted.', displayId: read.displayId };
      let content: string;
      try {
        content = archive.read(leagueId, row.tdfFileId).content;
      } catch {
        return { kind: 'blocked', code: 'tdf_key_mismatch', message: "The file can't be opened with this install's key.", displayId: read.displayId };
      }
      const { warnings, fingerprint } = warningsFor(leagueId, parseTdf(content), read, participants, correctionsOf(row));
      if (fingerprint !== row.acknowledgedFingerprint) {
        update(row.id, { warnings, warningsFingerprint: fingerprint });
        return { kind: 'warnings_changed', warnings, fingerprint, displayId: read.displayId };
      }
      return { kind: 'send', connectionId: c.id, tournamentId: row.tournamentId, displayId: read.displayId, name: read.name, content, fileId: row.tdfFileId };
    },

    record(uploadId, patch) {
      if (Object.keys(patch).length > 0) update(uploadId, patch);
    },

    peek(uploadId) {
      const row = byId(uploadId);
      return row ? { state: row.state, upstreamUploadId: row.upstreamUploadId, errorCode: row.errorCode } : null;
    },

    markKept(uploadId) {
      const row = byId(uploadId);
      if (row?.tdfFileId != null) archive.markKept(row.tdfFileId, 'results');
    },

    commitAttendance(leagueId, uploadId) {
      const row = byId(uploadId);
      if (!row || row.attendanceUploadId === null) throw new TournamentsError('not_found', 'No attendance import for this upload.');
      deps.attendance.commit(leagueId, row.sessionDate as SessionDate, row.attendanceUploadId);
    },

    follow,

    async section(leagueId, date, tournamentId) {
      const rows = db
        .select()
        .from(tournamentResultUpload)
        .where(and(eq(tournamentResultUpload.leagueId, leagueId), eq(tournamentResultUpload.tournamentId, tournamentId)))
        .orderBy(desc(tournamentResultUpload.id))
        .all();
      let latest = rows[0] ?? null;
      if (latest?.state === 'processing') {
        await follow(leagueId, latest.id);
        latest = byId(latest.id)!;
      }
      let upstream: ResultsSection['upstream'];
      try {
        const located = await locate(leagueId, date, tournamentId);
        const { read } = located;
        const u = uploadability(read, located.participants, now());
        upstream =
          read.activityState === 'upload_in_progress'
            ? { status: 'processing', reason: null }
            : read.activityState === 'completed' || read.status === 'complete'
              ? { status: 'complete', reason: null }
              : !u.ok
                ? { status: u.code, reason: u.reason }
                : { status: read.activityState === 'upload_failed' ? 'upload_failed' : 'awaiting_results', reason: null };
      } catch (err) {
        if (err instanceof TournamentsError && err.code === 'results_not_accepted') upstream = { status: 'results_not_accepted', reason: String(err.details.reason) };
        else if (err instanceof TournamentsError && err.code === 'not_found' && rows.length === 0) throw err;
        else if (err instanceof TournamentsError || err instanceof PokemonUpstreamError) upstream = { error: err.code };
        else throw err;
      }
      return {
        upstream,
        latest: latest ? uploadView(latest) : null,
        earlier: rows.slice(1).map((r) => ({ uploadId: r.id, state: r.state, createdAt: r.createdAt.toISOString() })),
        tdfAvailable: tdfAvailableIn(db, leagueId, [tournamentId]).size > 0,
      };
    },

    async recheckAfterStaff(leagueId, uploadId) {
      try {
        const row = byId(uploadId);
        if (!row || row.leagueId !== leagueId || row.state !== 'previewed') return;
        const located = await locate(leagueId, row.sessionDate, row.tournamentId);
        refresh(leagueId, row, located, row.acknowledgedBy ?? 'staff job');
      } catch {
        // Best effort (ADR-0011 Update #96): the confirm job's own check still guards the send.
      }
    },

    expirePreviews() {
      const cutoff = new Date(now().getTime() - PREVIEW_TTL_MS);
      return db
        .delete(tournamentResultUpload)
        .where(and(inArray(tournamentResultUpload.state, ['previewed']), lt(tournamentResultUpload.createdAt, cutoff)))
        .run().changes;
    },

    download(leagueId, tournamentId) {
      const row = db
        .select({ fileId: tournamentResultUpload.tdfFileId })
        .from(tournamentResultUpload)
        .where(servable(leagueId, [tournamentId]))
        .orderBy(desc(tournamentResultUpload.id))
        .get();
      const noTdf = () => new TournamentsError('no_tdf', 'This app has no copy of this tournament’s TDF.');
      if (row?.fileId == null) throw noTdf();
      try {
        return { fileId: row.fileId, ...archive.read(leagueId, row.fileId) };
      } catch (err) {
        // Deleted between the lookup and the read.
        if (err instanceof TdfFileNotFoundError) throw noTdf();
        throw err;
      }
    },

    tdfAvailable: (leagueId, tournamentIds) => tdfAvailableIn(db, leagueId, tournamentIds),
  };
}
