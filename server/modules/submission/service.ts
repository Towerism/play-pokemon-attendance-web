import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import { type Logger, silentLogger } from '@towerism/selfhost-kit';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { staffBatch, staffBatchItem, submission, submissionEvent, submissionItem, submissionLock, submissionTournamentItem } from '../../db/schema';
import type { SightingsService } from '../metrics/sightings';
import type { Actor } from '../accounts/service';
import { type ActingConnection, ConnectionAccessError, type PokemonConnectionService } from '../pokemon/connection';
import { type PokemonErrorCode, PokemonUpstreamError } from '../pokemon/ports/errors';
import type { BulkResult, PlayToolsGateway, Tournament, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import type { RosterService } from '../roster/service';
import type { SessionStatus, SessionsService } from '../sessions/service';
import type { StaffAssignmentRecord, StaffingService } from '../staffing/service';
import { StaffingError } from '../staffing/errors';
import { TournamentsError } from '../tournaments/errors';
import { assertMayActAs } from '../tournaments/organizer';
import type { ApplyBody, CancelBody, EditTarget } from '../../../shared/schemas/tournaments';
import type { CancelItem, CancelRead, TournamentCancelling } from '../tournaments/cancelling';
import type { EditItem, ItemRead, TournamentEditing } from '../tournaments/editing';
import type { CreatePlan, CreateRefusal, TournamentCreation, TournamentsService } from '../tournaments/service';
import type { ConfirmPlan, RemovalPlan, TournamentResults, UploadState } from '../tournaments/results';
import type { ResultsConfirmBody } from '../../../shared/schemas/results';
import { SubmissionError } from './errors';
import { forgetAttendance } from './forget';
import { dateIn } from '../../../shared/time/local-time';
import { type DesiredPlayer, type Plan, planSubmission } from './plan';
import { type PlaySessionResolver, type Resolution, leagueGroup } from './resolve';
import { type StafferDecision, classifyStaffer, refusalMessage } from './staff-plan';
import { type StaffBatchRowStatus, type StaffBatchView, batchStatus } from './staff-batch';

export type SubmissionStatus = (typeof submission.$inferSelect)['status'];
export type ItemOutcome = (typeof submissionItem.$inferSelect)['outcome'];
export type ItemOrigin = (typeof submissionItem.$inferSelect)['origin'];
export type SubmissionKind = (typeof submission.$inferSelect)['kind'];

export interface SubmissionItemView {
  playerId: PlayerId;
  displayName: string;
  origin: ItemOrigin;
  outcome: ItemOutcome;
  error: string | null;
  recordId: string | null;
  asStaff: boolean;
  /** On a submission: the undo that removed this record, if one did. */
  removedBy: number | null;
  /** Staff jobs: the wanted role; null otherwise. */
  role: string | null;
  /** Staff jobs: why the item failed, as a code (an upstream refusal code, `tournament_locked`, `local_write_failed`…). */
  errorCode: string | null;
  /** Staff jobs: the id a `merged_player_id` was merged into, as a suggestion. */
  suggestedPlayerId: PlayerId | null;
}

export interface SubmissionCounts {
  added: number;
  alreadyPresent: number;
  failed: number;
  skipped: number;
  unrequested: number;
}

export interface SubmissionSummary {
  id: number;
  date: SessionDate;
  playSessionLabel: string;
  startedBy: string;
  /** The professor whose Pokémon connection made the upstream calls (ADR-0008); null on attempts from before it. */
  professor: { playerId: string; name: string | null } | null;
  startedAt: Date;
  finishedAt: Date | null;
  status: SubmissionStatus;
  retryOf: number | null;
  /** `undo` removes the records the submission `undoOf` added; `clear` removes every player record in the play session. */
  kind: SubmissionKind;
  undoOf: number | null;
  /** Run under a tournament lease (ADR-0015 §5): `startedBy` is the lent professor, `professor` the organizer. */
  leased: boolean;
  /** Whether `undo` would start, as far as the database can tell (play-tools is not asked). */
  undoable: boolean;
  undoBlockedReason: 'not_undoable' | 'nothing_to_undo' | null;
  /** A staff job's tournament (`playSessionLabel` without "Staff for "); null for other kinds. */
  tournamentLabel: string | null;
  counts: SubmissionCounts;
}

export interface SubmissionView extends SubmissionSummary {
  playSessionId: string;
  /** Why the job stopped early; null otherwise. */
  error: string | null;
  items: SubmissionItemView[];
  /** A staff import's result; absent for other kinds. */
  staffImport?: StaffImportResult;
  /** A player import's result; absent for other kinds. */
  playerImport?: PlayerImportResult;
  /** A tournament job's items, in start order; empty for other kinds. */
  tournamentItems: TournamentItemView[];
}

export type TournamentItemOutcome = (typeof submissionTournamentItem.$inferSelect)['outcome'];

/** One tournament of a tournament job (#92). */
export interface TournamentItemView {
  position: number;
  plannedTournamentId: number | null;
  tournamentId: string | null;
  label: string;
  outcome: TournamentItemOutcome;
  /** `forbidden`, `refused`, `rate_limited`, `series_not_found`, `venue_not_found`, …; null when it went through. */
  errorCode: string | null;
  error: string | null;
  sentAt: string | null;
  shortNotice: boolean;
  support: SupportDetails | null;
}

/**
 * What Pokémon support needs to find a refused call (ADR-0010 decision 7): never a token, a request body or player
 * data.
 */
export interface SupportDetails {
  action: 'create' | 'edit' | 'reschedule' | 'cancel' | 'upload';
  sentAt: string | null;
  league: { displayId: string | null };
  tournament: { displayId: string | null; name: string; date: string };
  professor: { playerId: string; name: string | null };
  status: number | null;
  code: string | null;
  message: string | null;
  correlationId: string | null;
  /** A results upload's play-tools upload id (`upload_guid`), once validate answered (#96). */
  uploadGuid?: string | null;
  /** A results upload's validation error codes (#96); never player data. */
  errors?: string[];
}

/** What a staff import read and found (ADR-0007 decision 5). */
export interface StaffImportResult {
  tournamentsTotal: number;
  tournamentsRead: number;
  tournamentsFailed: number;
  /** Distinct staffers, one item each. */
  staffersFound: number;
  /** Staffers the league didn't know before, by their local name, then id: check their names on Players → Staff. */
  newPlayers: { playerId: PlayerId; name: string }[];
}

/** What a player import read and found (#35): the players the same tournaments list. */
export interface PlayerImportResult {
  tournamentsTotal: number;
  tournamentsRead: number;
  tournamentsFailed: number;
  /** Distinct players, one item each. */
  playersFound: number;
  /** Players the league didn't know before, by their local name, then id. */
  newPlayers: { playerId: PlayerId; name: string }[];
}

export type SubmissionEventType =
  | 'planned'
  | 'batch_sent'
  | 'batch_rejected'
  | 'retrying'
  | 'reconciled'
  | 'finished'
  | 'record_removed'
  /** A staff job sent one write (assign, role change or removal). */
  | 'staff_sent'
  /** A staff import read one tournament's participants; `done` of `total` count tournaments. */
  | 'tournament_read'
  /** A staff import gave up on one tournament and went on with the rest. */
  | 'tournament_failed'
  /** A staff import could not read one professor's tournaments and went on with the other professors (#75). */
  | 'professor_failed'
  /** A tournament job dealt with one tournament (#92). */
  | 'tournament_sent';

/** Progress, persisted before it is pushed. `done` of `total` players to add are dealt with. */
export interface SubmissionEvent {
  id: number;
  at: Date;
  type: SubmissionEventType;
  message: string;
  done: number;
  total: number;
}

/** What clearing a play session would delete, read fresh from play-tools. */
export interface ClearPreview {
  playSessionId: string;
  playSessionLabel: string;
  /** Every player record that would be deleted. */
  players: { playerId: PlayerId; name: string; addedByApp: boolean }[];
  /** Staff records (organizer, judges) are never deleted. */
  staffKept: number;
  /** Another play session that day holds records this app's submissions added. */
  otherSessionHasAppRecords: boolean;
}

export interface SubmissionService {
  /**
   * Checks the play session belongs to the date and is still editable, takes
   * the league's lock, and starts the job in the background, as one of the
   * actor's own connections that can submit (ADR-0015 §4): the one named, or
   * their only one.
   * @throws SubmissionError (`submit_as_required`, `cannot_submit` …), ConnectionAccessError, PokemonUpstreamError
   */
  start(leagueId: string, date: SessionDate, input: { playSessionId: string; actor: Actor; professorPlayerId?: string }): Promise<{ submissionId: number }>;
  /**
   * Retry (after `partial`/`failed`) or resume (after `interrupted`): a new
   * attempt for the same play session that plans again from upstream, as the
   * professor the attempt ran as, who must be the actor's (ADR-0015 §4).
   * @throws SubmissionError, ConnectionAccessError, PokemonUpstreamError
   */
  retry(leagueId: string, submissionId: number, actor: Actor): Promise<{ submissionId: number }>;
  /** The date's play sessions, read as the actor's own member connection, else anyone's (ADR-0015 §4). @throws SubmissionError, PokemonUpstreamError */
  resolve(leagueId: string, date: SessionDate, actor: Actor): Promise<Resolution>;
  /** @throws SubmissionError `not_found` */
  get(leagueId: string, submissionId: number): SubmissionView;
  /** Newest first. */
  list(leagueId: string, filter?: { date?: SessionDate }): SubmissionSummary[];
  /**
   * Removes the records submission `submissionId` added, as a new `undo`
   * attempt that runs in the background, as the professor the submission ran
   * as, who must be the actor's (ADR-0015 §4).
   * @throws SubmissionError, ConnectionAccessError, PokemonUpstreamError
   */
  undo(leagueId: string, submissionId: number, actor: Actor): Promise<{ submissionId: number }>;
  /** What `clear` would delete; changes nothing. Read as the actor's own member connection, else anyone's. @throws SubmissionError, PokemonUpstreamError */
  previewClear(leagueId: string, date: SessionDate, playSessionId: string, actor: Actor): Promise<ClearPreview>;
  /**
   * Clear session (danger zone): deletes every player record in the play
   * session, never a staff record, as a new `clear` attempt in the background,
   * as one of the actor's connections that can submit, chosen as `start` does.
   * @throws SubmissionError, ConnectionAccessError, PokemonUpstreamError
   */
  clear(leagueId: string, date: SessionDate, playSessionId: string, actor: Actor, professorPlayerId?: string): Promise<{ submissionId: number }>;
  /**
   * Applies one of the date's tournaments' staff assignments to play-tools
   * (ADR-0007), as a new `staff` job in the background.
   * @throws StaffingError, SubmissionError, PokemonUpstreamError
   */
  applyStaff(leagueId: string, date: SessionDate, input: { tournamentId: string; actor: Actor }): Promise<{ submissionId: number }>;
  /**
   * Import staff from play-tools (ADR-0007 decision 5): reads every tournament
   * the account organizes, in any league, into the staff list, as a new
   * read-only `staff_import` job in the background.
   * @throws SubmissionError, PokemonUpstreamError
   */
  importStaff(leagueId: string, actor: Actor): Promise<{ submissionId: number }>;
  /**
   * Import players from play-tools (#35): reads the same tournaments as
   * `importStaff` and adds the players they list to the league, as a new
   * read-only `player_import` job in the background. Records no sightings.
   * @throws SubmissionError, PokemonUpstreamError
   */
  importPlayers(leagueId: string, actor: Actor): Promise<{ submissionId: number }>;
  /**
   * Starts a staff batch (#76): the tournaments' staff jobs one after another, in the order given, each as its
   * organizer, holding the league's lease throughout. A tournament refused at its turn is not started; the rest go on.
   * A tournament whose organizer another user holds is refused before the batch starts (ADR-0015 §4).
   * @throws SubmissionError `submission_running`, `shutting_down`; StaffingError `not_your_connection` when no tournament is the actor's
   */
  applyStaffAll(leagueId: string, date: SessionDate, input: { tournamentIds: readonly string[]; actor: Actor }): Promise<{ batchId: number }>;
  /** @throws SubmissionError `not_found` for another league's batch or none */
  staffBatch(leagueId: string, batchId: number): StaffBatchView;
  /** The date's latest running staff batch, if any. */
  runningStaffBatch(leagueId: string, date: SessionDate): StaffBatchView | null;
  /**
   * **Create in play-tools** (ADR-0010 decision 5): a `tournament_create` job for 1–60 planned tournaments, each
   * created as its template's organizer, adopted instead when play-tools already has it.
   * @throws TournamentsError (the rows' checks), SubmissionError `submission_running`, `shutting_down`
   */
  createTournaments(
    leagueId: string,
    input: { plannedIds: readonly number[]; acknowledgeShortNotice: boolean; retryUnknown: boolean; actor: Actor },
  ): Promise<{ submissionId: number; refused: CreateRefusal[] }>;
  /**
   * **Create through date…**: the same job for every row a schedule plans through `date`, as its preview lists them.
   * @throws TournamentsError (also `too_many_tournaments`, `nothing_to_create`), SubmissionError
   */
  createThrough(
    leagueId: string,
    input: { scheduleId: number; date: string; acknowledgeShortNotice: boolean; actor: Actor },
  ): Promise<{ submissionId: number; refused: CreateRefusal[] }>;
  /**
   * **Edit…** (ADR-0010 decisions 8 and 11): the local changes, and a `tournament_edit` job for the tournaments in
   * play-tools, in one transaction. No job (`submissionId: null`) when only planned rows change.
   * @throws TournamentsError (the edit's refusals), SubmissionError `submission_running`, `shutting_down`
   */
  editTournaments(leagueId: string, input: { target: EditTarget; body: ApplyBody; actor: Actor }): Promise<{ submissionId: number | null; updatedLocally: number }>;
  /**
   * **Cancel…** (ADR-0010 decision 8): a `tournament_cancel` job for one tournament, confirmed from a fresh read. One
   * play-tools already cancelled is only cancelled locally, with no job (`submissionId: null`).
   * @throws TournamentsError (the preview's, `confirmation_mismatch`, `tournament_locked`), SubmissionError `submission_running`, `shutting_down`
   */
  cancelTournament(
    leagueId: string,
    input: { target: EditTarget; body: CancelBody; actor: Actor },
  ): Promise<{ submissionId: number } | { submissionId: null; outcome: 'already_cancelled' }>;
  /**
   * **Upload results** (ADR-0011 decision 4): the confirm's checks, then a `tdf_upload` job that validates (the send)
   * and confirms only if play-tools accepts the file.
   * @throws TournamentsError (the confirm's refusals), SubmissionError `submission_running`, `shutting_down`
   */
  uploadResults(
    leagueId: string,
    input: { date: SessionDate; tournamentId: string; uploadId: number; body: ResultsConfirmBody; actor: Actor },
  ): Promise<{ submissionId: number }>;
  /**
   * **Remove from staff** (ADR-0007 update, #101): the server's checks, then a staff job that only removes those
   * players' staff records, as the tournament's organizer.
   * @throws TournamentsError `not_removable` and the checks' others, SubmissionError `submission_running`, `shutting_down`
   */
  removeResultsStaff(
    leagueId: string,
    input: { date: SessionDate; tournamentId: string; uploadId: number; playerIds: readonly PlayerId[]; actor: Actor },
  ): Promise<{ submissionId: number }>;
  /** A `tdf_upload` job's processing, followed on this read (ADR-0011 Update #96); a no-op for other jobs. */
  followResults(leagueId: string, submissionId: number): Promise<void>;
  /** Per player, the session dates they were added to or already present on upstream (audit only, §5). */
  timesSubmitted(leagueId: string): Map<PlayerId, number>;
  /** Persisted events after `afterId`, oldest first. @throws SubmissionError `not_found` */
  events(leagueId: string, submissionId: number, afterId?: number): SubmissionEvent[];
  /** Live events for a submission; returns the unsubscribe. */
  subscribe(submissionId: number, listener: (event: SubmissionEvent) => void): () => void;
  /** On boot: jobs a crash left `planned`/`running` become `interrupted`, and their locks are freed. Returns how many. */
  recoverInterrupted(): number;
  /** Stops new batches, marks running jobs `interrupted`, and waits for them. */
  shutdown(): Promise<void>;
  /** Resolves once no job is running. */
  idle(): Promise<void>;
}

export interface SubmissionDeps {
  db: Db;
  /**
   * Tournament leases (ADR-0015 §5): whether the lease a staff or results job runs under is still live, checked before
   * each write; and the ending of a tournament's lease once a cancel job cancels it.
   */
  leases?: { isLive(leaseId: number): boolean; endLeasesForTournament(tournamentId: string, reason: 'tournament_cancelled'): void };
  sessions: Pick<SessionsService, 'getSession' | 'recordSubmission' | 'removePlayer' | 'resetAfterClear'>;
  roster: Pick<RosterService, 'ensurePlayers' | 'getPlayers'>;
  sightings: Pick<SightingsService, 'record' | 'retract'>;
  connections: Pick<PokemonConnectionService, 'league' | 'listActingConnections' | 'listReadableConnections' | 'actingConnection' | 'readingConnection'>;
  /** Attendance calls as one professor's connection: the one a job runs as (ADR-0015 §4). */
  gateway: (connectionId: number) => Pick<PlayToolsGateway, 'listAttendance' | 'addAttendanceBulk' | 'removeAttendance'>;
  /** The tournament calls staff jobs and imports make (ADR-0007), as one professor's connection (#75). */
  staffGateway: (
    connectionId: number | null,
  ) => Pick<
    PlayToolsGateway,
    | 'listLeagues'
    | 'listTournaments'
    | 'getTournament'
    | 'listTournamentParticipants'
    | 'listStaffRoles'
    | 'assignStaff'
    | 'changeStaffRole'
    | 'unassignStaff'
  >;
  /** The calls a tournament job makes besides the tournaments module's reads, as one professor's connection (#92). */
  tournamentGateway?: (
    connectionId: number,
  ) => Pick<PlayToolsGateway, 'createTournament' | 'editTournament' | 'cancelTournament' | 'getTournament' | 'validateResults' | 'confirmResults'>;
  staffing: Pick<
    StaffingService,
    'prepareApply' | 'organizersOn' | 'assignmentsFor' | 'recordApplied' | 'recordFailed' | 'forgetRemoved' | 'recordUpstreamStaff' | 'forgetPlayed'
  >;
  resolver: PlaySessionResolver;
  /** Planned tournaments, for `tournament_create` jobs (#92); only those jobs need it. */
  tournaments?: {
    creation: TournamentCreation;
    createThrough: TournamentsService['createThrough'];
    editing?: TournamentEditing;
    cancelling?: TournamentCancelling;
    /** Required-events coverage: its cached listings are dropped when a tournament job ends (#95). */
    requiredEvents?: Pick<TournamentsService['requiredEvents'], 'listingsChanged'>;
    /** TDF results uploads (#96): `tdf_upload` jobs and Remove-from-staff jobs reach uploads only through it. */
    results?: TournamentResults;
  };
  /** At least this long between tournament creates (NUXT_TOURNAMENT_DELAY_MS): default 5 s, never under 2 s (ADR-0010 decision 5). */
  tournamentDelayMs?: number;
  /** The league timezone (ADR-0006): a staff import is dated by the day it starts in it. Default: the process's. */
  timeZone?: string;
  now?: () => Date;
  /** Rejects with `signal.reason` when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Default 20, at most 50 (ADR-0004). Smaller batches rarely hit the 502 gateway timeout. */
  batchSize?: number;
  /** Default 10 s between bulk calls (ADR-0004 update). */
  batchDelayMs?: number;
  /**
   * After a 5xx on a bulk call, how long to keep re-reading for the batch to
   * show up before resending (default 3 min). Large batches can 502 at the
   * gateway yet still be recorded about a minute later (field report, M5).
   */
  settleMs?: number;
  /** How often to re-read while settling (default 15 s). */
  settlePollMs?: number;
  /** Default 1 s between undo deletes, one at a time. */
  undoDelayMs?: number;
  /** Default 1 s between a staff job's writes, one at a time; never under 500 ms (NUXT_STAFF_DELAY_MS). */
  staffDelayMs?: number;
  log?: Pick<Logger, 'warn' | 'info'>;
}

type Row = typeof submission.$inferSelect;
type ItemInsert = typeof submissionItem.$inferInsert;

/** Retries of one batch after a 429/5xx, before its players are failed. */
const MAX_RETRIES = 2;
/** The lock's lease, renewed before every bulk call; a crashed process's lease frees itself. */
const LEASE_MS = 2 * 60_000;
const ACTIVE: SubmissionStatus[] = ['planned', 'running'];
/** An undo or clear item whose record play-tools no longer has. */
const GONE: ItemOutcome[] = ['removed', 'already_removed'];
/** A staff item whose record play-tools holds in the wanted role. */
const HELD: ItemOutcome[] = ['assigned', 'already_assigned', 'role_changed'];
/** Staff item outcomes that mean the job did not get its way. */
const STAFF_UNDONE: ItemOutcome[] = ['failed', 'ineligible', 'skipped'];
const STAFF_PREFIX = 'Staff for ';
/** Tries of one staff import read after a 429 or a 5xx, before giving up on it. */
const IMPORT_TRIES = 3;
/** Read errors after which a staff import gives up on that tournament only, without trying again. */
const SKIPPED_TOURNAMENT: PokemonErrorCode[] = ['not_found', 'unexpected_shape'];

/**
 * Whether a staff import gives up on one tournament and goes on: gone, unreadable, or
 * refused with a 403 (that tournament's league, #67). A 401 is the token, so it stops.
 */
function skipsTournament(err: PokemonUpstreamError): boolean {
  return SKIPPED_TOURNAMENT.includes(err.code) || (err.code === 'forbidden' && err.details.status === 403);
}
/** The tournament imports: each reads every connected professor's tournaments and keeps part of who they list. */
type ImportKind = 'staff_import' | 'player_import';
const IMPORT_KINDS: readonly SubmissionKind[] = ['staff_import', 'player_import'];
const isImport = (row: { kind: SubmissionKind }): row is { kind: ImportKind } => IMPORT_KINDS.includes(row.kind);
/** An import's `play_session_label`; it has no play session or tournament of its own. */
const IMPORT_LABEL: Record<ImportKind, string> = { staff_import: 'Staff import', player_import: 'Player import' };

const DRAFT_STATUS: Record<SubmissionStatus, SessionStatus> = {
  planned: 'submitting',
  running: 'submitting',
  succeeded: 'submitted',
  partial: 'partial',
  failed: 'failed',
  interrupted: 'failed',
};

/** Stops a staff job for the whole tournament; the message is the code History shows. */
class StaffStop extends Error {
  override name = 'StaffStop';
  constructor(readonly code: 'tournament_locked' | 'forbidden' | 'unknown_tournament' | 'lease_ended') {
    super(code);
  }
}

/** Upstream errors after which a staff job sends nothing more to the tournament. */
const STAFF_STOPS = new Set(['tournament_locked', 'forbidden']);
/** Upstream errors after which a tournament job sends nothing more (ADR-0010 decision 5). */
const CREATE_STOPS = new Set(['forbidden', 'needs_reconnect', 'not_connected']);
/** Upstream errors that stop any job: the connection itself is gone. */
const CONNECTION_LOST = new Set(['needs_reconnect', 'not_connected']);

class Interrupted extends Error {
  override name = 'Interrupted';
  constructor() {
    super('The app stopped while this submission was running. Resume it to finish.');
  }
}

/** Jobs whose items are `submission_tournament_item` rows (ADR-0010 decision 7). */
const isTournamentJob = (row: { kind: SubmissionKind }) =>
  row.kind === 'tournament_create' || row.kind === 'tournament_edit' || row.kind === 'tournament_cancel' || row.kind === 'tdf_upload';
/** A staff job started by Remove from staff (#96): it only removes the players it names. */
const isRemoval = (row: { kind: SubmissionKind; resultsUploadId: number | null }) => row.kind === 'staff' && row.resultsUploadId !== null;

/** How logs name a job. */
const what = (row: { kind: SubmissionKind }) =>
  ({ submit: 'Submission', undo: 'Undo', clear: 'Clear', staff: 'Staff job', tournament_create: 'Tournament create', tournament_edit: 'Tournament edit', tournament_cancel: 'Tournament cancel', tdf_upload: 'Results upload', ...IMPORT_LABEL })[row.kind];

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The submission module (ADR-0004): plan → execute → reconcile, as a
 * background job. It never asks "did I send this before?", only "what is
 * upstream missing?", so running it again is always safe.
 */
export function createSubmissionService(deps: SubmissionDeps): SubmissionService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? abortableSleep;
  const batchSize = deps.batchSize ?? 20;
  const batchDelayMs = deps.batchDelayMs ?? 10_000;
  const settleMs = deps.settleMs ?? 3 * 60_000;
  const settlePollMs = deps.settlePollMs ?? 15_000;
  const undoDelayMs = deps.undoDelayMs ?? 1_000;
  const staffDelayMs = Math.max(500, deps.staffDelayMs ?? 1_000);
  const tournamentDelayMs = Math.max(2_000, deps.tournamentDelayMs ?? 5_000);
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const log = deps.log ?? silentLogger;

  const running = new Set<Promise<void>>();
  /** Per league, when its last staff write went out: the spacing holds across one batch's jobs too (#76). */
  const lastStaffWrite = new Map<string, number>();
  /** Per league, when its last tournament create went out. */
  const lastTournamentPost = new Map<string, number>();
  const listeners = new Map<number, Set<(event: SubmissionEvent) => void>>();
  const stop = new AbortController();

  // --- persistence -----------------------------------------------------------

  const load = (leagueId: string, submissionId: number): Row | undefined =>
    db
      .select()
      .from(submission)
      .where(and(eq(submission.id, submissionId), eq(submission.leagueId, leagueId)))
      .get();

  function mustFind(leagueId: string, submissionId: number): Row {
    const row = load(leagueId, submissionId);
    if (!row) throw new SubmissionError('not_found', `Submission ${submissionId} does not exist.`);
    return row;
  }

  function setItems(items: ItemInsert[]): void {
    for (const item of items) {
      db.insert(submissionItem)
        .values(item)
        .onConflictDoUpdate({
          target: [submissionItem.submissionId, submissionItem.playerId],
          set: {
            outcome: item.outcome,
            error: item.error ?? null,
            recordId: item.recordId ?? null,
            asStaff: item.asStaff ?? false,
            role: item.role ?? null,
            errorCode: item.errorCode ?? null,
            suggestedPlayerId: item.suggestedPlayerId ?? null,
          },
        })
        .run();
    }
  }

  function setOutcome(submissionId: number, playerIds: readonly PlayerId[], set: Partial<ItemInsert>): void {
    if (playerIds.length === 0) return;
    db.update(submissionItem)
      .set(set)
      .where(and(eq(submissionItem.submissionId, submissionId), inArray(submissionItem.playerId, [...playerIds])))
      .run();
  }

  function emit(row: Row, type: SubmissionEventType, message: string, done: number, total: number): void {
    const event = db
      .insert(submissionEvent)
      .values({ submissionId: row.id, at: now(), type, message, done, total })
      .returning()
      .get();
    const view = { id: event.id, at: event.at, type, message, done, total };
    for (const listener of listeners.get(row.id) ?? []) {
      try {
        listener(view);
      } catch (err) {
        log.warn(`A progress listener failed: ${(err as Error).message}`, { submissionId: row.id });
      }
    }
  }

  function setStatus(row: Row, status: SubmissionStatus, error: string | null = null): void {
    const finished = !ACTIVE.includes(status);
    db.update(submission)
      .set({ status, error, ...(finished ? { finishedAt: now() } : {}) })
      .where(eq(submission.id, row.id))
      .run();
    // An undo or a clear leaves the draft's status and play session alone.
    if (row.kind !== 'submit') return;
    deps.sessions.recordSubmission(row.leagueId, row.sessionDate as SessionDate, {
      playSessionId: row.playSessionId,
      status: DRAFT_STATUS[status],
    });
  }

  function counts(row: Pick<Row, 'id' | 'kind'>): SubmissionCounts {
    if (isTournamentJob(row)) {
      const outcomes = tournamentItems(row.id).map((i) => i.outcome);
      const count = (...o: TournamentItemOutcome[]) => outcomes.filter((x) => o.includes(x)).length;
      return {
        added: count('created', 'edited', 'cancelled', 'processing', 'uploaded'),
        alreadyPresent: count('already_exists', 'already_applied', 'already_cancelled'),
        failed: count(
          'refused',
          'failed',
          'unknown',
          'date_too_far_past',
          'date_too_far_ahead',
          'not_accepted',
          'warnings_changed',
          'validate_unknown',
          'processing_failed',
        ),
        skipped: count('skipped'),
        unrequested: 0,
      };
    }
    const outcomes = db
      .select({ outcome: submissionItem.outcome })
      .from(submissionItem)
      .where(eq(submissionItem.submissionId, row.id))
      .all();
    const count = (...o: ItemOutcome[]) => outcomes.filter((i) => o.includes(i.outcome)).length;
    if (row.kind === 'staff') {
      return {
        added: count('assigned', 'role_changed', 'removed'),
        alreadyPresent: count('already_assigned', 'already_listed', 'is_organizer', 'already_removed'),
        failed: count('failed', 'ineligible'),
        skipped: count('skipped'),
        unrequested: 0,
      };
    }
    return {
      added: count('added'),
      alreadyPresent: count('already_present'),
      failed: count('failed'),
      skipped: count('skipped'),
      unrequested: count('unrequested'),
    };
  }

  /** The professor an attempt runs as, as it records them. */
  const professorOf = (c: ActingConnection) => ({ professorPlayerId: c.professorPlayerId, professorName: c.professorName });

  const connectionName = (c: Pick<ActingConnection, 'professorName' | 'professorPlayerId'>) => c.professorName ?? `Professor ${c.professorPlayerId}`;

  /**
   * The connection an attendance attempt (submit, clear) runs as (ADR-0015 §4): one the actor holds that is a member
   * allowed to record attendance. The one named; otherwise their only such one.
   * @throws SubmissionError `cannot_submit`, `submit_as_required`; ConnectionAccessError; PokemonUpstreamError
   */
  function submitter(actor: Actor, professorPlayerId?: string): ActingConnection {
    const mine = deps.connections.listActingConnections().filter((c) => c.userId === actor.userId);
    if (professorPlayerId !== undefined) {
      const { connectionId } = deps.connections.actingConnection(actor, professorPlayerId, { kind: 'own' });
      const c = mine.find((x) => x.id === connectionId)!;
      if (!c.canSubmit) throw new SubmissionError('cannot_submit', `${connectionName(c)}'s Pokémon account may not record attendance for this league.`);
      return c;
    }
    if (mine.length === 0) throw new PokemonUpstreamError('not_connected', 'Connect your Pokémon account in Settings first.');
    const able = mine.filter((c) => c.canSubmit);
    if (able.length === 0) throw new SubmissionError('cannot_submit', 'None of your Pokémon accounts can record attendance for this league.');
    if (able.length > 1) throw new SubmissionError('submit_as_required', 'Choose which of your Pokémon accounts to submit as.');
    const only = able[0]!;
    if (only.status === 'needs_reconnect') throw new PokemonUpstreamError('needs_reconnect', `Reconnect ${connectionName(only)} in Settings.`);
    return only;
  }

  /**
   * The connection an undo or a retry runs as: the professor the attempt ran as, and only when the actor holds that
   * connection (ADR-0015 §4). An attempt from before professors were recorded can't be redone or undone.
   * @throws ConnectionAccessError
   */
  function originalConnection(actor: Actor, row: Pick<Row, 'professorPlayerId'>): ActingConnection {
    if (row.professorPlayerId === null) {
      throw new ConnectionAccessError('not_your_connection', 'This attempt has no recorded professor, so it can be neither retried nor undone.', '');
    }
    const { connectionId } = deps.connections.actingConnection(actor, row.professorPlayerId, { kind: 'own' });
    return deps.connections.listActingConnections().find((c) => c.id === connectionId)!;
  }

  /** Whether a leased job's lease has ended (ADR-0015 §5); never for a job run as the organizer's own. */
  const leaseEnded = (row: Pick<Row, 'leaseId'>) => row.leaseId !== null && !(deps.leases?.isLive(row.leaseId) ?? false);

  /** A leased staff job stops before its next write once its lease has ended. */
  function assertLeaseLive(row: Pick<Row, 'leaseId'>): void {
    if (leaseEnded(row)) throw new StaffStop('lease_ended');
  }

  /**
   * The connection a staff job runs as: the professor stamped on it, its tournament's organizer (#75).
   * Never another professor's: a job whose professor is gone or can't act stops.
   */
  function stampedConnection(row: Row): number {
    const p = deps.connections.listActingConnections().find((c) => c.professorPlayerId !== null && c.professorPlayerId === row.professorPlayerId);
    if (!p) throw new PokemonUpstreamError('not_connected', `Professor ${row.professorPlayerId}'s Pokémon account is no longer connected.`);
    if (p.status === 'needs_reconnect') throw new PokemonUpstreamError('needs_reconnect', `Reconnect ${p.professorName ?? `Professor ${p.professorPlayerId}`} in Settings.`);
    return p.id;
  }

  function summary(row: Row): SubmissionSummary {
    const blocked = row.kind !== 'submit' || ACTIVE.includes(row.status) ? 'not_undoable' : undoTargets(row).length === 0 ? 'nothing_to_undo' : null;
    return {
      id: row.id,
      date: row.sessionDate as SessionDate,
      playSessionLabel: row.playSessionLabel,
      startedBy: row.startedBy,
      professor: row.professorPlayerId === null ? null : { playerId: row.professorPlayerId, name: row.professorName },
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      status: row.status,
      retryOf: row.retryOf,
      kind: row.kind,
      undoOf: row.undoOf,
      leased: row.leaseId !== null,
      undoable: blocked === null,
      undoBlockedReason: blocked,
      tournamentLabel: row.kind === 'staff' ? row.playSessionLabel.replace(STAFF_PREFIX, '') : null,
      counts: counts(row),
    };
  }

  /** Record ids this league's own submissions added to the play session. */
  function ourRecordIds(row: Pick<Row, 'leagueId' | 'playSessionId'>): Set<string> {
    const rows = db
      .select({ recordId: submissionItem.recordId })
      .from(submissionItem)
      .innerJoin(submission, eq(submission.id, submissionItem.submissionId))
      .where(and(eq(submission.leagueId, row.leagueId), eq(submission.playSessionId, row.playSessionId), eq(submissionItem.outcome, 'added')))
      .all();
    return new Set(rows.map((r) => r.recordId).filter((r): r is string => r !== null));
  }

  // --- the lock --------------------------------------------------------------

  /** Takes the league's lease; throws while another submission holds an unexpired one. Call inside a transaction. */
  function acquireLock(leagueId: string, submissionId: number): void {
    assertUnlocked(leagueId);
    const lease = { submissionId, expiresAt: new Date(now().getTime() + LEASE_MS) };
    db.insert(submissionLock)
      .values({ leagueId, ...lease })
      .onConflictDoUpdate({ target: submissionLock.leagueId, set: lease })
      .run();
  }

  /** Throws while another job holds an unexpired lease for the league. */
  function assertUnlocked(leagueId: string): void {
    const held = db.select().from(submissionLock).where(eq(submissionLock.leagueId, leagueId)).get();
    if (held && held.expiresAt > now()) {
      throw new SubmissionError('submission_running', 'A submission is already running for this league. Wait for it to finish.');
    }
  }

  /** Moves the league's lease from one holder to another without freeing it in between (a staff batch, #76). */
  function handOverLock(leagueId: string, from: number, to: number): void {
    db.update(submissionLock)
      .set({ submissionId: to, expiresAt: new Date(now().getTime() + LEASE_MS) })
      .where(and(eq(submissionLock.leagueId, leagueId), eq(submissionLock.submissionId, from)))
      .run();
  }

  function renewLock(row: Pick<Row, 'leagueId' | 'id'>, extraMs = 0): void {
    db.update(submissionLock)
      .set({ expiresAt: new Date(now().getTime() + LEASE_MS + extraMs) })
      .where(and(eq(submissionLock.leagueId, row.leagueId), eq(submissionLock.submissionId, row.id)))
      .run();
  }

  function releaseLock(row: Pick<Row, 'leagueId' | 'id'>): void {
    db.delete(submissionLock)
      .where(and(eq(submissionLock.leagueId, row.leagueId), eq(submissionLock.submissionId, row.id)))
      .run();
  }

  // --- the job ---------------------------------------------------------------

  async function run(row: Row): Promise<void> {
    const { leagueId } = row;
    const date = row.sessionDate as SessionDate;
    const groupId = leagueGroup(deps.connections, leagueId);
    // Each call goes through the connection the attempt recorded; once it is gone, the job stops (ADR-0015 §4).
    const gateway = () => deps.gateway(stampedConnection(row));
    const listAttendance = () => gateway().listAttendance(groupId, row.playSessionId);
    setStatus(row, 'running');

    // 1. Plan
    const draft = deps.sessions.getSession(leagueId, date);
    const desired: DesiredPlayer[] = [
      ...draft.players.map((p) => ({ playerId: p.playerId, origin: 'session' as const })),
      ...draft.regulars.map((p) => ({ playerId: p.playerId, origin: 'regular' as const })),
    ];
    const ours = ourRecordIds(row);
    const plan = planSubmission(desired, await listAttendance());
    savePlan(row, plan, ours);
    const total = plan.toAdd.length;
    emit(row, 'planned', `${total} to add, ${plan.alreadyPresent.length} already in play-tools.`, 0, total);

    // 2. Execute
    const errors = new Map<PlayerId, string>();
    /** Recorded upstream by someone else while we ran: not ours to call added. */
    const othersAdded = new Set<PlayerId>();
    /** Sent in a batch that got a 5xx: upstream may still record them, late. */
    const inFlight = new Set<PlayerId>();
    let done = 0;
    let lastBulkAt: number | undefined;

    /** Re-reads every `settlePollMs` until all of `players` are recorded or `settleMs` has passed; returns who is. */
    async function settle(players: readonly PlayerId[]): Promise<Set<PlayerId>> {
      const deadline = now().getTime() + settleMs;
      for (;;) {
        if (stop.signal.aborted) throw stop.signal.reason;
        renewLock(row, settlePollMs);
        await sleep(settlePollMs, stop.signal);
        const present = new Set((await listAttendance()).map((r) => r.playerId));
        if (players.every((p) => present.has(p)) || now().getTime() >= deadline) return present;
      }
    }

    /** Keeps bulk calls at least `batchDelayMs` apart, or longer when play-tools asks; stops on shutdown. */
    async function pace(atLeastMs = 0): Promise<void> {
      if (stop.signal.aborted) throw stop.signal.reason;
      const spacing = lastBulkAt === undefined ? 0 : lastBulkAt + batchDelayMs - now().getTime();
      const wait = Math.max(spacing, atLeastMs);
      renewLock(row, wait);
      if (wait > 0) await sleep(wait, stop.signal);
    }

    async function sendBatch(batch: PlayerId[]): Promise<void> {
      let pending = batch;
      let resent = false;
      let retries = 0;
      while (pending.length > 0) {
        await pace();
        let result: BulkResult;
        try {
          lastBulkAt = now().getTime();
          result = await gateway().addAttendanceBulk(groupId, row.playSessionId, pending);
        } catch (err) {
          if (!(err instanceof PokemonUpstreamError) || !err.retryable) throw err;
          const timedOut = err.code === 'unavailable';
          if (timedOut) for (const p of pending) inFlight.add(p);
          if (retries >= MAX_RETRIES) {
            for (const p of pending) errors.set(p, err.message);
            done += pending.length;
            return;
          }
          retries += 1;
          let present: Set<PlayerId>;
          if (timedOut) {
            // A 502 on a large batch is often a gateway timeout: play-tools still records the
            // players, and they show up about a minute later. Wait for them; never send anyone twice.
            emit(row, 'retrying', `${err.message} Waiting to see whether play-tools recorded the batch anyway.`, done, total);
            present = await settle(pending);
          } else {
            emit(row, 'retrying', `${err.message} Trying that batch again.`, done, total);
            await pace(err.details.retryAfterMs);
            present = new Set((await listAttendance()).map((r) => r.playerId));
          }
          done += pending.filter((p) => present.has(p)).length;
          pending = pending.filter((p) => !present.has(p));
          continue;
        }

        if (result.status === 'added') {
          // Kept now, so a run that stops early still knows what it added (S4: ids in request order).
          for (const r of result.records) setOutcome(row.id, [r.playerId], { outcome: 'added', recordId: r.recordId });
          done += pending.length;
          emit(row, 'batch_sent', `Sent ${done} of ${total}.`, done, total);
          return;
        }

        // S4: a rejected batch added nobody. Drop who it named and resend the rest once.
        // A duplicate from our own timed-out batch landing late is still ours.
        for (const p of result.alreadyPresent) if (!inFlight.has(p)) othersAdded.add(p);
        for (const f of result.failed) errors.set(f.playerId, f.error);
        const named = new Set([...result.alreadyPresent, ...result.failed.map((f) => f.playerId)]);
        done += named.size;
        const rest = pending.filter((p) => !named.has(p));
        if (resent) {
          for (const p of rest) errors.set(p, 'play-tools turned away the whole batch twice.');
          done += rest.length;
          return;
        }
        emit(row, 'batch_rejected', `play-tools refused ${named.size} of the batch; sending the other ${rest.length} again.`, done, total);
        resent = true;
        pending = rest;
      }
    }

    for (let i = 0; i < plan.toAdd.length; i += batchSize) {
      await sendBatch(plan.toAdd.slice(i, i + batchSize).map((p) => p.playerId));
    }

    // 3. Reconcile: upstream is the source of truth for "is this person recorded".
    const after = new Map((await listAttendance()).map((r) => [r.playerId, r]));
    let added = 0;
    setItems(
      plan.toAdd.map((p) => {
        const record = after.get(p.playerId);
        const base = { ...p, submissionId: row.id, recordId: record?.recordId ?? null };
        if (record && othersAdded.has(p.playerId)) return { ...base, outcome: 'already_present' as const, asStaff: !record.isPlayer };
        if (record) {
          added += 1;
          return { ...base, outcome: 'added' as const };
        }
        return { ...base, outcome: 'failed' as const, error: errors.get(p.playerId) ?? 'Not recorded in play-tools after sending.' };
      }),
    );
    emit(row, 'reconciled', `play-tools has ${added} of the ${total - othersAdded.size} players sent.`, total, total);

    const status = added === total - othersAdded.size ? 'succeeded' : added > 0 ? 'partial' : 'failed';
    setStatus(row, status);
    emit(row, 'finished', `Submission ${status}.`, total, total);
  }

  /** A player whose upstream records a job deletes: one record for an undo, every record of theirs for a clear. */
  interface RemovalTarget {
    playerId: PlayerId;
    recordIds: string[];
  }

  /**
   * Deletes the targets' records one at a time, at least `undoDelayMs` apart,
   * and stores each player's outcome as soon as their deletes return (the
   * final re-read decides). Shared by undo and clear.
   */
  async function removeAll(row: Row, groupId: string, targets: readonly RemovalTarget[], done: number, total: number): Promise<void> {
    const gateway = () => deps.gateway(stampedConnection(row));
    let lastDeleteAt: number | undefined;
    /** Keeps deletes at least `undoDelayMs` apart, or longer when play-tools asks; stops on shutdown. */
    async function pace(atLeastMs = 0): Promise<void> {
      if (stop.signal.aborted) throw stop.signal.reason;
      const spacing = lastDeleteAt === undefined ? 0 : lastDeleteAt + undoDelayMs - now().getTime();
      const wait = Math.max(spacing, atLeastMs);
      renewLock(row, wait);
      if (wait > 0) await sleep(wait, stop.signal);
    }

    /** Deletes one record: tried at most `MAX_RETRIES + 1` times, re-reading first after a 5xx (it may have landed). */
    async function remove(recordId: string): Promise<{ outcome: 'removed' | 'already_removed' } | { outcome: 'failed'; error: string }> {
      for (let retries = 0; ; retries += 1) {
        await pace();
        try {
          lastDeleteAt = now().getTime();
          const result = await gateway().removeAttendance(groupId, row.playSessionId, recordId);
          return { outcome: result === 'removed' ? 'removed' : 'already_removed' };
        } catch (err) {
          if (!(err instanceof PokemonUpstreamError) || !err.retryable) throw err;
          if (retries >= MAX_RETRIES) return { outcome: 'failed', error: err.message };
          emit(row, 'retrying', `${err.message} Trying that record again.`, done, total);
          await pace(err.details.retryAfterMs);
          if (err.code === 'unavailable') {
            const listed = await gateway().listAttendance(groupId, row.playSessionId);
            if (!listed.some((r) => r.recordId === recordId)) return { outcome: 'removed' };
          }
        }
      }
    }

    for (const target of targets) {
      const results = [];
      for (const recordId of target.recordIds) results.push(await remove(recordId));
      const failed = results.find((r) => r.outcome === 'failed');
      const outcome = failed ? 'failed' : results.some((r) => r.outcome === 'removed') ? 'removed' : 'already_removed';
      setOutcome(row.id, [target.playerId], { outcome, error: failed && 'error' in failed ? failed.error : null });
      done += 1;
      emit(row, 'record_removed', `Removed ${done} of ${total}.`, done, total);
    }
  }

  /**
   * Reconcile after deleting: upstream decides. A player with a record still
   * listed was not removed, whatever the delete said. Then makes the outcomes
   * final with what they mean locally, and returns the job's status.
   */
  async function reconcileRemoval(row: Row, groupId: string, recordsOf: ReadonlyMap<string, readonly string[]>, total: number) {
    const still = new Set((await deps.gateway(stampedConnection(row)).listAttendance(groupId, row.playSessionId)).map((r) => r.recordId));
    for (const [playerId, recordIds] of recordsOf) {
      if (recordIds.some((r) => still.has(r))) {
        db.update(submissionItem)
          .set({ outcome: 'failed', error: 'Still in play-tools after removing.' })
          .where(and(eq(submissionItem.submissionId, row.id), eq(submissionItem.playerId, playerId), inArray(submissionItem.outcome, GONE)))
          .run();
      }
    }
    finishRemoval(row);
    const removed = db
      .select({ outcome: submissionItem.outcome })
      .from(submissionItem)
      .where(eq(submissionItem.submissionId, row.id))
      .all()
      .filter((i) => GONE.includes(i.outcome)).length;
    emit(row, 'reconciled', `play-tools no longer has ${removed} of the ${total} records.`, total, total);
    return removed === total ? 'succeeded' : removed > 0 ? 'partial' : 'failed';
  }

  /** Undo: delete each targeted record play-tools still has, then re-read to see what is gone. */
  async function runUndo(row: Row): Promise<void> {
    const groupId = leagueGroup(deps.connections, row.leagueId);
    const gateway = deps.gateway(stampedConnection(row));
    setStatus(row, 'running');

    const items = db.select().from(submissionItem).where(eq(submissionItem.submissionId, row.id)).all();
    const total = items.length;
    emit(row, 'planned', `${total} to remove.`, 0, total);
    // Collect every page first (spike F4: deleting shifts the pages), and only delete what is still ours.
    const listed = new Map((await gateway.listAttendance(groupId, row.playSessionId)).map((r) => [r.recordId, r]));
    let done = 0;
    const toDelete: RemovalTarget[] = [];
    for (const item of items) {
      const record = listed.get(item.recordId!);
      if (!record) {
        setOutcome(row.id, [item.playerId as PlayerId], { outcome: 'already_removed' });
        done += 1;
      } else if (record.playerId !== item.playerId) {
        setOutcome(row.id, [item.playerId as PlayerId], { outcome: 'failed', error: 'record_mismatch' });
        done += 1;
      } else {
        toDelete.push({ playerId: item.playerId as PlayerId, recordIds: [item.recordId!] });
      }
    }

    await removeAll(row, groupId, toDelete, done, total);
    const recordsOf = new Map(items.filter((i) => i.recordId !== null).map((i) => [i.playerId, [i.recordId!]]));
    const status = await reconcileRemoval(row, groupId, recordsOf, total);
    setStatus(row, status);
    emit(row, 'finished', `Undo ${status}.`, total, total);
  }

  /**
   * Clear session: read every page once, then delete every player record
   * that read listed (never a staff record, never one added later), then
   * re-read. A clear that removed everyone resets the date's draft.
   */
  async function runClear(row: Row): Promise<void> {
    const groupId = leagueGroup(deps.connections, row.leagueId);
    setStatus(row, 'running');

    const recordsOf = new Map<string, string[]>();
    const names = new Map<string, string>();
    for (const r of await deps.gateway(stampedConnection(row)).listAttendance(groupId, row.playSessionId)) {
      if (!r.isPlayer) continue;
      recordsOf.set(r.playerId, [...(recordsOf.get(r.playerId) ?? []), r.recordId]);
      if (r.name && !names.has(r.playerId)) names.set(r.playerId, r.name);
    }
    const targets = [...recordsOf].map(([playerId, recordIds]) => ({ playerId: playerId as PlayerId, recordIds }));
    db.transaction(() => {
      deps.roster.ensurePlayers(
        row.leagueId,
        targets.map((t) => ({ playerId: t.playerId, name: names.get(t.playerId) })),
      );
      setItems(
        targets.map((t) => ({ submissionId: row.id, playerId: t.playerId, origin: 'upstream' as const, outcome: 'pending' as const, recordId: t.recordIds[0] })),
      );
    });
    const total = targets.length;
    emit(row, 'planned', `${total} to remove.`, 0, total);

    await removeAll(row, groupId, targets, 0, total);
    const status = await reconcileRemoval(row, groupId, recordsOf, total);
    setStatus(row, status);
    if (status === 'succeeded') deps.sessions.resetAfterClear(row.leagueId, row.sessionDate as SessionDate);
    emit(row, 'finished', `Clear ${status}.`, total, total);
  }

  /** One staff item's outcome, as the job decides it. */
  interface StaffOutcome {
    outcome: ItemOutcome;
    recordId?: string | null;
    error?: string | null;
    errorCode?: string | null;
    suggestedPlayerId?: PlayerId | null;
  }

  /**
   * Staff job (ADR-0007 decisions 4 and 7–12): brings one tournament's staff
   * in play-tools in line with the organizer's assignments. Every decision
   * rests on a fresh read: the organizer and anyone the tournament lists are
   * never sent, and only records this app holds are re-roled or removed.
   */
  async function runStaff(row: Row): Promise<void> {
    const { leagueId } = row;
    const tournamentId = row.playSessionId;
    assertLeaseLive(row);
    const gateway = deps.staffGateway(stampedConnection(row));
    const roles = gateway.listStaffRoles();
    const roleLabel = (code: string) => roles.find((r) => r.code === code)?.label ?? code;
    setStatus(row, 'running');

    // 1. Plan: the tournament's organizer and everyone it lists, every page.
    let organizerPlayerId: PlayerId;
    let seedAs: { id: string; startsAt: Date | null; organizerPlayerId: PlayerId };
    try {
      const details = await gateway.getTournament(tournamentId);
      organizerPlayerId = details.organizerPlayerId;
      seedAs = { id: details.id, startsAt: details.startsAt, organizerPlayerId };
    } catch (err) {
      if (err instanceof PokemonUpstreamError && err.code === 'not_found') throw new StaffStop('unknown_tournament');
      throw err;
    }
    /** Reads everyone on the tournament, and seeds the staff list from what it found. */
    async function read(): Promise<TournamentParticipant[]> {
      try {
        const participants = await gateway.listTournamentParticipants(tournamentId);
        deps.staffing.recordUpstreamStaff(leagueId, seedAs, participants);
        return participants;
      } catch (err) {
        if (err instanceof PokemonUpstreamError && STAFF_STOPS.has(err.code)) throw new StaffStop(err.code as 'tournament_locked' | 'forbidden');
        throw err;
      }
    }
    const decide = (a: StaffAssignmentRecord, listed: readonly TournamentParticipant[]): StafferDecision =>
      classifyStaffer({ playerId: a.playerId, role: a.role, recordId: a.recordId }, listed, organizerPlayerId, roles);
    /** A decision that sends nothing, as an outcome; `sentByUs` turns an adopted record into our own landed assign. */
    function settled(decision: Exclude<StafferDecision, { kind: 'assign' | 'rechange' }>, sentByUs = false): StaffOutcome {
      if (decision.kind === 'already_assigned') return { outcome: sentByUs ? 'assigned' : 'already_assigned', recordId: decision.recordId };
      if (decision.kind === 'already_listed') return { outcome: 'already_listed', error: decision.how };
      return { outcome: 'is_organizer' };
    }

    let listed = await read();
    const assignments = deps.staffing.assignmentsFor(leagueId, tournamentId);
    const live = new Map(assignments.filter((a) => !a.removed).map((a) => [a.playerId, a]));
    const tombstoned = new Map(assignments.filter((a) => a.removed && a.recordId && !live.has(a.playerId)).map((a) => [a.playerId, a]));

    const toRemove: StaffAssignmentRecord[] = [];
    const toRechange: StaffAssignmentRecord[] = [];
    const toAssign: StaffAssignmentRecord[] = [];
    const planned: ItemInsert[] = [];
    const item = (a: StaffAssignmentRecord, o: StaffOutcome): ItemInsert => ({
      submissionId: row.id,
      playerId: a.playerId,
      origin: 'session',
      role: a.role,
      recordId: o.recordId ?? null,
      outcome: o.outcome,
      error: o.error ?? null,
      errorCode: o.errorCode ?? null,
      suggestedPlayerId: o.suggestedPlayerId ?? null,
    });
    for (const a of tombstoned.values()) {
      const still = listed.some((p) => p.recordId === a.recordId);
      if (still) toRemove.push(a);
      planned.push(item(a, { outcome: still ? 'pending' : 'already_removed', recordId: a.recordId }));
    }
    for (const a of live.values()) {
      const decision = decide(a, listed);
      if (decision.kind === 'assign') toAssign.push(a);
      if (decision.kind === 'rechange') toRechange.push(a);
      const pending = decision.kind === 'assign' || decision.kind === 'rechange';
      planned.push(item(a, pending ? { outcome: 'pending', recordId: decision.kind === 'rechange' ? decision.recordId : null } : settled(decision)));
    }
    db.transaction(() => {
      deps.roster.ensurePlayers(leagueId, planned.map((p) => ({ playerId: p.playerId as PlayerId })));
      setItems(planned);
    });
    const total = planned.length;
    let done = planned.filter((p) => p.outcome !== 'pending').length;
    emit(row, 'planned', `${toRemove.length} to remove, ${toRechange.length} role changes, ${toAssign.length} to assign.`, done, total);

    // 2. Execute: one write at a time, removals, then role changes, then assigns.
    /** Keeps writes at least `staffDelayMs` apart, or longer when play-tools asks; stops on shutdown or an ended lease. */
    async function pace(atLeastMs = 0): Promise<void> {
      if (stop.signal.aborted) throw stop.signal.reason;
      assertLeaseLive(row);
      const lastWriteAt = lastStaffWrite.get(leagueId);
      const spacing = lastWriteAt === undefined ? 0 : lastWriteAt + staffDelayMs - now().getTime();
      const wait = Math.max(spacing, atLeastMs);
      renewLock(row, wait);
      if (wait > 0) await sleep(wait, stop.signal);
    }

    function record(a: StaffAssignmentRecord, o: StaffOutcome, message: string): void {
      setOutcome(row.id, [a.playerId], {
        outcome: o.outcome,
        error: o.error ?? null,
        errorCode: o.errorCode ?? null,
        suggestedPlayerId: o.suggestedPlayerId ?? null,
        ...(o.recordId !== undefined ? { recordId: o.recordId } : {}),
      });
      done += 1;
      emit(row, 'staff_sent', message, done, total);
    }

    /**
     * What a failed write means for its item: `retry` after a 429 or 5xx (it may
     * have landed, so the caller re-reads first), the item's outcome after a
     * refusal of just this staffer; throws when the job must stop.
     */
    function failure(a: StaffAssignmentRecord, err: unknown, tries: number): StaffOutcome | 'retry' {
      if (err instanceof TypeError) return { outcome: 'failed', error: err.message, errorCode: 'invalid_input' };
      if (!(err instanceof PokemonUpstreamError)) throw err;
      if (STAFF_STOPS.has(err.code)) {
        setOutcome(row.id, [a.playerId], { outcome: 'failed', error: err.message, errorCode: err.code });
        throw new StaffStop(err.code as 'tournament_locked' | 'forbidden');
      }
      if (CONNECTION_LOST.has(err.code)) throw err;
      if (!err.retryable || tries >= MAX_RETRIES) return { outcome: 'failed', error: err.message, errorCode: err.code };
      return 'retry';
    }

    /** A fresh read for one item's decision: retried like a write; null when play-tools never answered. */
    async function readFor(a: StaffAssignmentRecord): Promise<TournamentParticipant[] | StaffOutcome> {
      for (let tries = 0; ; tries += 1) {
        try {
          return (listed = await read());
        } catch (err) {
          const next = failure(a, err, tries);
          if (next !== 'retry') return next;
          emit(row, 'retrying', `${(err as Error).message} Reading the tournament again.`, done, total);
          await pace(Math.max(staffDelayMs, (err as PokemonUpstreamError).details.retryAfterMs ?? 0));
        }
      }
    }

    for (const a of toRemove) {
      let outcome: StaffOutcome | undefined;
      for (let tries = 0; !outcome; tries += 1) {
        await pace();
        try {
          lastStaffWrite.set(leagueId, now().getTime());
          const result = await gateway.unassignStaff(tournamentId, a.recordId!, a.playerId);
          outcome = { outcome: result === 'removed' ? 'removed' : 'already_removed' };
        } catch (err) {
          const next = failure(a, err, tries);
          if (next !== 'retry') {
            outcome = next;
            break;
          }
          emit(row, 'retrying', `${(err as Error).message} Checking whether the removal landed.`, done, total);
          await pace((err as PokemonUpstreamError).details.retryAfterMs);
          const fresh = await readFor(a);
          if (!Array.isArray(fresh)) outcome = fresh;
          else if (!fresh.some((p) => p.recordId === a.recordId)) outcome = { outcome: 'removed' };
        }
      }
      record(a, outcome, `Removed ${a.playerId}.`);
    }

    /** After a role change found its record gone: decide again from a fresh read. */
    async function redecide(a: StaffAssignmentRecord): Promise<StaffOutcome | 'assign'> {
      const fresh = await readFor(a);
      if (!Array.isArray(fresh)) return fresh;
      const decision = decide({ ...a, recordId: null }, fresh);
      if (decision.kind === 'assign') return 'assign';
      if (decision.kind === 'rechange') return { outcome: 'already_listed', error: `Listed as ${roleLabel(a.role)}` };
      return settled(decision);
    }

    for (const a of toRechange) {
      let outcome: StaffOutcome | 'assign' | undefined;
      for (let tries = 0; !outcome; tries += 1) {
        await pace();
        try {
          lastStaffWrite.set(leagueId, now().getTime());
          const result = await gateway.changeStaffRole(tournamentId, a.recordId!, a.role as never);
          outcome = result === 'changed' ? { outcome: 'role_changed', recordId: a.recordId } : await redecide(a);
        } catch (err) {
          const next = failure(a, err, tries);
          if (next !== 'retry') {
            outcome = next;
            break;
          }
          emit(row, 'retrying', `${(err as Error).message} Checking whether the role change landed.`, done, total);
          await pace((err as PokemonUpstreamError).details.retryAfterMs);
          const fresh = await readFor(a);
          if (!Array.isArray(fresh)) outcome = fresh;
          else {
            const own = fresh.find((p) => p.recordId === a.recordId);
            if (own?.role === a.role) outcome = { outcome: 'role_changed', recordId: a.recordId };
            else if (!own) outcome = await redecide(a);
          }
        }
      }
      if (outcome === 'assign') toAssign.push({ ...a, recordId: null });
      else record(a, outcome, outcome.outcome === 'role_changed' ? `Changed ${a.playerId} to ${roleLabel(a.role)}.` : `${a.playerId}: ${outcome.outcome}.`);
    }

    for (const a of toAssign) {
      let outcome: StaffOutcome | undefined;
      let sent = false;
      for (let tries = 0; !outcome; tries += 1) {
        await pace();
        // Never send a player id the tournament lists, or its organizer: checked against play-tools right now.
        const fresh = await readFor(a);
        if (!Array.isArray(fresh)) {
          outcome = fresh;
          break;
        }
        const decision = decide(a, fresh);
        if (decision.kind !== 'assign') {
          outcome = decision.kind === 'rechange' ? { outcome: 'already_listed', error: `Listed as ${roleLabel(a.role)}` } : settled(decision, sent);
          break;
        }
        try {
          lastStaffWrite.set(leagueId, now().getTime());
          sent = true;
          const result = await gateway.assignStaff(tournamentId, { playerId: a.playerId, role: a.role as never });
          if (result.status === 'assigned') outcome = { outcome: 'assigned', recordId: result.recordId };
          else if (result.status === 'invalid') outcome = { outcome: 'failed', error: result.code, errorCode: result.code };
          else if (result.code === 'cannot_duplicate_participant') {
            // Someone listed them between the re-read and the call: read again, never resend.
            const after = await readFor(a);
            if (!Array.isArray(after)) outcome = after;
            else {
              const again = decide(a, after);
              outcome = again.kind === 'assign' || again.kind === 'rechange' ? { outcome: 'already_listed', error: result.code } : settled(again);
            }
          } else {
            outcome = {
              outcome: 'ineligible',
              error: refusalMessage(result.code, result.suggestedPlayerId),
              errorCode: result.code,
              suggestedPlayerId: result.suggestedPlayerId ?? null,
            };
          }
        } catch (err) {
          const next = failure(a, err, tries);
          if (next !== 'retry') {
            outcome = next;
            break;
          }
          emit(row, 'retrying', `${(err as Error).message} Checking whether the assignment landed.`, done, total);
          await pace((err as PokemonUpstreamError).details.retryAfterMs);
        }
      }
      record(a, outcome, outcome.outcome === 'assigned' ? `Assigned ${a.playerId} as ${roleLabel(a.role)}.` : `${a.playerId}: ${outcome.outcome}.`);
    }

    // 3. Reconcile: upstream is the source of truth for who holds which record.
    const after = await read();
    const items = db.select().from(submissionItem).where(eq(submissionItem.submissionId, row.id)).all();
    for (const i of items) {
      if ((i.outcome === 'assigned' || i.outcome === 'role_changed') && !after.some((p) => p.recordId === i.recordId && p.role === i.role)) {
        setOutcome(row.id, [i.playerId as PlayerId], { outcome: 'failed', error: 'Not in play-tools after assigning.', errorCode: null });
      }
      if (i.outcome === 'removed' && after.some((p) => p.recordId === i.recordId)) {
        setOutcome(row.id, [i.playerId as PlayerId], { outcome: 'failed', error: 'Still in play-tools after removing.', errorCode: null });
      }
    }
    finishStaff(row);
    const final = db.select({ outcome: submissionItem.outcome }).from(submissionItem).where(eq(submissionItem.submissionId, row.id)).all();
    const missed = final.filter((i) => STAFF_UNDONE.includes(i.outcome)).length;
    emit(row, 'reconciled', `play-tools matches ${total - missed} of the ${total} staff.`, total, total);
    const status = missed === 0 ? 'succeeded' : missed < total ? 'partial' : 'failed';
    setStatus(row, status);
    emit(row, 'finished', `Staff job ${status}.`, total, total);
  }

  /**
   * Writes each decided staff item back to its assignment, in one transaction
   * with the item: held records become the assignment's (and the staff list's),
   * removed ones drop the tombstone, failures mark it failed. A failed local
   * write fails that item; the next apply's plan heals it.
   */
  function finishStaff(row: Row): void {
    const assignments = deps.staffing.assignmentsFor(row.leagueId, row.playSessionId);
    const items = db.select().from(submissionItem).where(eq(submissionItem.submissionId, row.id)).all();
    for (const i of items) {
      const live = assignments.find((a) => a.playerId === i.playerId && !a.removed);
      const gone = assignments.find((a) => a.playerId === i.playerId && a.removed);
      try {
        db.transaction(() => {
          setOutcome(row.id, [i.playerId as PlayerId], { outcome: i.outcome });
          if (HELD.includes(i.outcome) && live && i.recordId && i.role) {
            deps.staffing.recordApplied(row.leagueId, live.id, { recordId: i.recordId, role: i.role });
          } else if (GONE.includes(i.outcome) && gone) {
            deps.staffing.forgetRemoved(row.leagueId, gone.id);
          } else if ((i.outcome === 'failed' || i.outcome === 'ineligible') && (live ?? gone)) {
            deps.staffing.recordFailed(row.leagueId, (live ?? gone)!.id);
          }
        });
      } catch (err) {
        log.warn(`${what(row)} #${row.id} could not update staffer ${i.playerId} locally: ${(err as Error).message}`, {
          submissionId: row.id,
          playerId: i.playerId,
        });
        setOutcome(row.id, [i.playerId as PlayerId], {
          outcome: 'failed',
          error: `play-tools: ${i.outcome}; saving it here failed.`,
          errorCode: 'local_write_failed',
        });
      }
    }
  }

  /**
   * Makes each removed record's outcome final together with what it means
   * locally: the player is off the date's session players and their tdf and
   * manual sightings are gone (a clear also retracts upstream_existing, since
   * it deleted the very records that sighting stood for), unless another play
   * session that day still has them. One transaction per player; a failed
   * local write fails that player.
   */
  function finishRemoval(row: Row): void {
    const date = row.sessionDate as SessionDate;
    const gone = db
      .select()
      .from(submissionItem)
      .where(and(eq(submissionItem.submissionId, row.id), inArray(submissionItem.outcome, GONE)))
      .all();
    for (const item of gone) {
      const playerId = item.playerId as PlayerId;
      try {
        db.transaction(() => {
          setOutcome(row.id, [playerId], { outcome: item.outcome, error: null });
          if (recordedElsewhere(row, playerId)) return;
          forgetAttendance(deps, row.leagueId, date, playerId);
          if (row.kind === 'clear') deps.sightings.retract(row.leagueId, date, 'upstream_existing', [playerId]);
        });
      } catch (err) {
        log.warn(`${what(row)} #${row.id} could not update player ${playerId} locally: ${(err as Error).message}`, { submissionId: row.id, playerId });
        setOutcome(row.id, [playerId], { outcome: 'failed', error: 'local_write_failed' });
      }
    }
  }

  /** Another play session on the same date still has the player (added or present there, and not undone or cleared since). */
  function recordedElsewhere(row: Row, playerId: PlayerId): boolean {
    return heldElsewhere(row.leagueId, row.sessionDate, row.playSessionId, ['added', 'already_present']).some((h) => h.playerId === playerId);
  }

  /**
   * Players that submissions for the date's other play sessions recorded with
   * one of `outcomes`, leaving out those an undo of that submission, or a
   * later clear of that play session, has removed.
   */
  function heldElsewhere(leagueId: string, date: string, playSessionId: string, outcomes: ItemOutcome[]) {
    const held = db
      .select({ submissionId: submissionItem.submissionId, playerId: submissionItem.playerId, playSessionId: submission.playSessionId })
      .from(submissionItem)
      .innerJoin(submission, eq(submission.id, submissionItem.submissionId))
      .where(
        and(
          eq(submission.leagueId, leagueId),
          eq(submission.sessionDate, date),
          eq(submission.kind, 'submit'),
          ne(submission.playSessionId, playSessionId),
          inArray(submissionItem.outcome, outcomes),
        ),
      )
      .all();
    if (held.length === 0) return [];
    const cleared = db
      .select({ clearId: submission.id, playerId: submissionItem.playerId, playSessionId: submission.playSessionId })
      .from(submissionItem)
      .innerJoin(submission, eq(submission.id, submissionItem.submissionId))
      .where(
        and(
          eq(submission.leagueId, leagueId),
          eq(submission.sessionDate, date),
          eq(submission.kind, 'clear'),
          inArray(submissionItem.outcome, GONE),
        ),
      )
      .all();
    return held.filter(
      (h) =>
        removedBy(h.submissionId).get(h.playerId) === undefined &&
        !cleared.some((c) => c.playerId === h.playerId && c.playSessionId === h.playSessionId && c.clearId > h.submissionId),
    );
  }

  /** Per player, the undo of `submissionId` that removed their record. */
  function removedBy(submissionId: number): Map<string, number> {
    const rows = db
      .select({ playerId: submissionItem.playerId, undoId: submission.id })
      .from(submissionItem)
      .innerJoin(submission, eq(submission.id, submissionItem.submissionId))
      .where(and(eq(submission.undoOf, submissionId), inArray(submissionItem.outcome, GONE)))
      .all();
    return new Map(rows.map((r) => [r.playerId, r.undoId]));
  }

  function savePlan(row: Row, plan: Plan, ours: Set<string>): void {
    const date = row.sessionDate as SessionDate;
    db.transaction(() => {
      deps.roster.ensurePlayers(
        row.leagueId,
        plan.extra.map((r) => ({ playerId: r.playerId, name: r.name || undefined })),
      );
      setItems([
        ...plan.alreadyPresent.map((p) => ({ ...p, submissionId: row.id, outcome: 'already_present' as const })),
        ...plan.toAdd.map((p) => ({ ...p, submissionId: row.id, outcome: 'pending' as const })),
        ...plan.extra.map((r) => ({
          submissionId: row.id,
          playerId: r.playerId,
          origin: 'upstream' as const,
          outcome: 'unrequested' as const,
          recordId: r.recordId,
        })),
      ]);
      // Evidence someone else recorded them upstream (ADR-0005); our own earlier adds are not.
      deps.sightings.record(
        row.leagueId,
        date,
        'upstream_existing',
        plan.extra.filter((r) => !ours.has(r.recordId)).map((r) => r.playerId),
      );
    });
  }

  /**
   * Staff import (ADR-0007 decision 5, #75) and player import (#35): read
   * every tournament each connected professor organizes, in the leagues they
   * are in today, as that professor, and seed the staff list (staff import) or
   * the league's players (player import) from each one's participants. A
   * tournament two professors list is read once. One professor's failure stops
   * only their reads. Read-only, one call at a time and unpaced (organizer,
   * 2026-10-12: reads don't need pacing).
   */
  async function runImport(row: Row & { kind: ImportKind }): Promise<void> {
    const label = IMPORT_LABEL[row.kind];
    const seed = row.kind === 'staff_import' ? seedFrom : seedPlayersFrom;
    setStatus(row, 'running');
    let total = 0;
    let done = 0;
    let failed = 0;
    let professorsFailed = 0;
    let lastFailure: string | null = null;

    /** One read, tried at most `IMPORT_TRIES` times after a 429 or a 5xx; waits only when play-tools asks; stops on shutdown. */
    async function read<T>(call: () => Promise<T>, what: string): Promise<T> {
      for (let tries = 1; ; tries += 1) {
        if (stop.signal.aborted) throw stop.signal.reason;
        renewLock(row);
        try {
          return await call();
        } catch (err) {
          if (!(err instanceof PokemonUpstreamError) || !err.retryable || tries >= IMPORT_TRIES) throw err;
          emit(row, 'retrying', `${err.message} Reading ${what} again.`, done, total);
          const wait = err.details.retryAfterMs ?? 0;
          if (wait > 0) {
            renewLock(row, wait);
            await sleep(wait, stop.signal);
          }
        }
      }
    }

    const nameOf = (c: ActingConnection) =>
      c.professorName ? `${c.professorName} (${c.professorPlayerId})` : `Professor ${c.professorPlayerId ?? '(not identified yet)'}`;
    /** A professor whose login or listing failed: the import goes on with the others. */
    function professorFailed(c: ActingConnection, code: string): void {
      professorsFailed += 1;
      lastFailure = code;
      log.warn(`${label} #${row.id} could not read professor ${c.professorPlayerId}'s tournaments: ${code}`, {
        submissionId: row.id,
        professorPlayerId: c.professorPlayerId,
        code,
      });
      emit(row, 'professor_failed', `Could not read ${nameOf(c)}'s tournaments: ${code}.`, done + failed, total);
    }

    // Plan: each professor's own tournaments (play-tools lists only the caller's), in the leagues they are in
    // today: play-tools still lists tournaments from leagues an account has left, but refuses their records (#67).
    const plan: { conn: ActingConnection; gateway: ReturnType<SubmissionDeps['staffGateway']>; t: Tournament }[] = [];
    let leftOut = 0;
    for (const conn of deps.connections.listReadableConnections()) {
      if (conn.status === 'needs_reconnect') {
        professorFailed(conn, 'needs_reconnect');
        continue;
      }
      const gateway = deps.staffGateway(conn.id);
      try {
        const leagues = new Set((await read(() => gateway.listLeagues(), 'the leagues')).map((l) => l.id));
        const listed = await read(() => gateway.listTournaments(), 'the tournaments');
        const theirs = listed.filter((t) => t.groupId === null || leagues.has(t.groupId));
        leftOut += listed.length - theirs.length;
        for (const t of theirs) if (!plan.some((p) => p.t.id === t.id)) plan.push({ conn, gateway, t });
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        professorFailed(conn, err.code);
      }
    }
    total = plan.length;
    const why = leftOut ? `; ${leftOut} left out (leagues this account is no longer in)` : '';
    emit(row, 'planned', `${total} tournaments to read${why}.`, 0, total);

    /** Everyone found so far: once new to the league, a player stays `new_player` for the whole import. */
    const found = new Map<PlayerId, 'found' | 'new_player'>();
    const stopped = new Set<number>();
    for (const [i, { conn, gateway, t }] of plan.entries()) {
      if (stopped.has(conn.id)) continue;
      let participants: TournamentParticipant[];
      try {
        participants = await read(() => gateway.listTournamentParticipants(t.id), 'that tournament');
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        if (!(err.retryable || skipsTournament(err))) {
          // The login itself (a 401, needs_reconnect): none of this professor's other tournaments can be read either.
          stopped.add(conn.id);
          total -= plan.slice(i).filter((p) => p.conn.id === conn.id).length;
          professorFailed(conn, err.code);
          continue;
        }
        // Gone, unreadable, refused (403), or still down after 3 tries: this tournament only.
        failed += 1;
        lastFailure = err.code;
        log.warn(`${label} #${row.id} could not read tournament ${t.id}: ${err.code}`, {
          submissionId: row.id,
          tournamentId: t.id,
          code: err.code,
          status: err.details.status,
        });
        const when = t.startsAt ? dateIn(t.startsAt, timeZone) : 'undated';
        emit(row, 'tournament_failed', `Could not read tournament ${t.displayId ?? t.id} (${when}): ${err.code}.`, done + failed, total);
        continue;
      }
      db.transaction(() => seed(row, t, participants, found));
      done += 1;
      emit(row, 'tournament_read', `Read ${done} of ${total} tournaments.`, done + failed, total);
    }
    const status = failed === 0 && professorsFailed === 0 ? 'succeeded' : done > 0 ? 'partial' : 'failed';
    setStatus(row, status, status === 'failed' ? lastFailure : null);
    const who = row.kind === 'staff_import' ? 'staff' : found.size === 1 ? 'player' : 'players';
    emit(row, 'finished', `${label} ${status}: read ${done} of ${total} tournaments, found ${found.size} ${who}.`, done + failed, total);
  }

  /**
   * Seeds the staff list from one tournament's participants and records each
   * staffer as an item. The organizer is whoever holds the `organizer` record,
   * so the import needs no `getTournament` read.
   */
  function seedFrom(
    row: Row,
    t: Pick<Tournament, 'id' | 'startsAt'>,
    participants: readonly TournamentParticipant[],
    found: Map<PlayerId, 'found' | 'new_player'>,
  ): void {
    const organizerPlayerId = participants.find((p) => p.role === 'organizer')?.playerId ?? ('' as PlayerId);
    const added = new Set(deps.staffing.recordUpstreamStaff(row.leagueId, { id: t.id, startsAt: t.startsAt, organizerPlayerId }, participants));
    // The staffers recordUpstreamStaff records: staff records other than the organizer's.
    const staff = participants.filter((p) => p.isStaff && p.role !== null && p.role !== 'organizer' && p.playerId !== organizerPlayerId);
    for (const { playerId } of staff) {
      found.set(playerId, added.has(playerId) || found.get(playerId) === 'new_player' ? 'new_player' : 'found');
    }
    setItems(
      [...new Set(staff.map((p) => p.playerId))].map((playerId) => ({
        submissionId: row.id,
        playerId,
        origin: 'upstream' as const,
        outcome: found.get(playerId)!,
      })),
    );
  }

  /**
   * Adds one tournament's players (not its staff) to the league and records
   * each as an item. Names only fill a player the app could not name; no
   * sighting, regular or staff history is written (#35).
   */
  function seedPlayersFrom(
    row: Row,
    _t: Pick<Tournament, 'id' | 'startsAt'>,
    participants: readonly TournamentParticipant[],
    found: Map<PlayerId, 'found' | 'new_player'>,
  ): void {
    const players = participants.filter((p) => !p.isStaff);
    const ids = [...new Set(players.map((p) => p.playerId))];
    const known = new Set(deps.roster.getPlayers(row.leagueId, ids).map((p) => p.playerId));
    deps.roster.ensurePlayers(row.leagueId, players.map((p) => ({ playerId: p.playerId, name: p.name })));    for (const playerId of ids) {
      found.set(playerId, !known.has(playerId) || found.get(playerId) === 'new_player' ? 'new_player' : 'found');
    }
    setItems(ids.map((playerId) => ({ submissionId: row.id, playerId, origin: 'upstream' as const, outcome: found.get(playerId)! })));
  }

  /** An import's tournaments: planned, read and given up on, from its events. */
  function importProgress(row: Pick<Row, 'id'>): Pick<StaffImportResult, 'tournamentsTotal' | 'tournamentsRead' | 'tournamentsFailed'> {
    const events = db
      .select({ type: submissionEvent.type, total: submissionEvent.total })
      .from(submissionEvent)
      .where(eq(submissionEvent.submissionId, row.id))
      .all();
    return {
      tournamentsTotal: events.find((e) => e.type === 'planned')?.total ?? 0,
      tournamentsRead: events.filter((e) => e.type === 'tournament_read').length,
      tournamentsFailed: events.filter((e) => e.type === 'tournament_failed').length,
    };
  }

  /** A staff import's result: its progress, and the staffers its items hold. */
  function staffImportResult(row: Row, items: readonly { playerId: string; outcome: ItemOutcome }[], names: Map<PlayerId, string>): StaffImportResult {
    const newPlayers = items
      .filter((i) => i.outcome === 'new_player')
      .map((i) => ({ playerId: i.playerId as PlayerId, name: names.get(i.playerId as PlayerId) ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.playerId.localeCompare(b.playerId));
    return { ...importProgress(row), staffersFound: items.length, newPlayers };
  }

  /** A player import's result: its progress, and the players its items hold. */
  function playerImportResult(row: Row, items: readonly { playerId: string; outcome: ItemOutcome }[], names: Map<PlayerId, string>): PlayerImportResult {
    const { staffersFound, ...rest } = staffImportResult(row, items, names);
    return { ...rest, playersFound: staffersFound };
  }

  // --- tournament jobs (#92) -------------------------------------------------

  function tournamentGateway(connectionId: number) {
    if (!deps.tournamentGateway) throw new Error('This app was built without the tournaments module.');
    return deps.tournamentGateway(connectionId);
  }

  function creation(): TournamentCreation {
    if (!deps.tournaments) throw new Error('This app was built without the tournaments module.');
    return deps.tournaments.creation;
  }

  function tournamentItems(submissionId: number) {
    return db
      .select()
      .from(submissionTournamentItem)
      .where(eq(submissionTournamentItem.submissionId, submissionId))
      .orderBy(submissionTournamentItem.position)
      .all();
  }

  function setTournamentItem(submissionId: number, position: number, set: Partial<typeof submissionTournamentItem.$inferInsert>): void {
    db.update(submissionTournamentItem)
      .set(set)
      .where(and(eq(submissionTournamentItem.submissionId, submissionId), eq(submissionTournamentItem.position, position)))
      .run();
  }

  /** Who a connection is, for support details. */
  function professorAs(connectionId: number) {
    const c = deps.connections.listActingConnections().find((x) => x.id === connectionId);
    return { playerId: c?.professorPlayerId ?? '', name: c?.professorName ?? null };
  }

  /** Support details for a refused or uncertain create (ADR-0010 decision 7). */
  function support(
    leagueId: string,
    at: { name: string; date: string; connectionId: number; sentAt: Date | null; action?: SupportDetails['action']; displayId?: string | null },
    err?: PokemonUpstreamError,
  ): SupportDetails {
    return {
      action: at.action ?? 'create',
      sentAt: at.sentAt?.toISOString() ?? null,
      league: { displayId: deps.connections.league(leagueId)?.displayId ?? null },
      tournament: { displayId: at.displayId ?? null, name: at.name, date: at.date },
      professor: professorAs(at.connectionId),
      status: err?.details.status ?? null,
      code: err?.details.upstream?.code ?? null,
      message: err?.details.upstream?.message ?? null,
      correlationId: err?.details.upstream?.correlationId ?? null,
    };
  }

  /** Stops a tournament job; the message is the code History shows. */
  class TournamentStop extends Error {
    override name = 'TournamentStop';
  }

  /**
   * `tournament_create` (ADR-0010 decision 5, #100): for each held planned tournament in start order, as its
   * organizer, adopt a matching tournament or send one create, paced. A create that may have landed is settled by
   * re-listing and never sent again; with no match it is `unknown`. The window is checked again before each send.
   */
  async function runTournamentCreate(row: Row): Promise<void> {
    const { leagueId } = row;
    const t = creation();
    setStatus(row, 'running');
    const items = tournamentItems(row.id);
    const total = items.length;
    let done = 0;
    emit(row, 'planned', `${total} ${total === 1 ? 'tournament' : 'tournaments'} to create.`, 0, total);
    /** Each tournament the job holds a guid for, and the connection to re-read it as. */
    const created: { position: number; plannedId: number; tournamentId: string; connectionId: number }[] = [];

    const step = (message: string) => {
      done += 1;
      emit(row, 'tournament_sent', message, done, total);
    };

    /** Keeps creates at least `tournamentDelayMs` apart across the league's jobs; stops on shutdown. */
    async function pace(): Promise<void> {
      if (stop.signal.aborted) throw stop.signal.reason;
      const last = lastTournamentPost.get(leagueId);
      const wait = last === undefined ? 0 : last + tournamentDelayMs - now().getTime();
      renewLock(row, Math.max(0, wait));
      if (wait > 0) await sleep(wait, stop.signal);
    }

    /** After a create that may have landed: re-list until the settle window ends. Null: not seen, or not readable. */
    async function settle(plan: Extract<CreatePlan, { kind: 'send' }>): Promise<string | null> {
      const deadline = now().getTime() + settleMs;
      for (;;) {
        if (stop.signal.aborted) throw stop.signal.reason;
        renewLock(row, settlePollMs);
        await sleep(settlePollMs, stop.signal);
        try {
          const found = await t.findLanded(leagueId, plan.connectionId, plan.match);
          if (found) return found;
        } catch (err) {
          if (!(err instanceof PokemonUpstreamError)) throw err;
          return null;
        }
        if (now().getTime() >= deadline) return null;
      }
    }

    for (const item of items) {
      if (item.outcome !== 'pending') continue;
      if (stop.signal.aborted) throw stop.signal.reason;
      renewLock(row);
      const plannedId = item.plannedTournamentId!;
      const name = item.label.replace(/ · \d{4}-\d{2}-\d{2}$/, '');
      const date = item.label.slice(-10);

      let plan: CreatePlan;
      try {
        plan = await t.planItem(leagueId, plannedId);
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        setTournamentItem(row.id, item.position, { outcome: 'refused', errorCode: err.code, error: err.message });
        t.recordFailed(leagueId, plannedId, err.code);
        step(`${item.label}: ${err.code}.`);
        throw new TournamentStop(err.code);
      }
      if (plan.kind === 'adopt') {
        setTournamentItem(row.id, item.position, { outcome: 'already_exists', tournamentId: plan.tournamentId });
        t.recordCreated(leagueId, plannedId, plan.tournamentId);
        created.push({ position: item.position, plannedId, tournamentId: plan.tournamentId, connectionId: plan.connectionId });
        step(`${item.label}: already in play-tools.`);
        continue;
      }
      if (plan.kind === 'fail') {
        setTournamentItem(row.id, item.position, {
          outcome: 'failed',
          errorCode: plan.code,
          error: plan.message,
          ...(plan.error && { support: support(leagueId, { name, date, connectionId: plan.connectionId ?? 0, sentAt: null }, plan.error) }),
        });
        t.recordFailed(leagueId, plannedId, plan.code);
        step(`${item.label}: ${plan.code}.`);
        continue;
      }

      await pace();
      const problem = t.windowProblem(plan.localDate);
      if (problem) {
        setTournamentItem(row.id, item.position, { outcome: problem, errorCode: problem, error: `${plan.localDate} is no longer in the creatable window.` });
        t.recordFailed(leagueId, plannedId, problem);
        step(`${item.label}: ${problem}.`);
        continue;
      }
      const sentAt = now();
      db.transaction(() => {
        setTournamentItem(row.id, item.position, { sentAt });
        t.recordSent(leagueId, plannedId, sentAt);
      });
      const at = { name: plan.tournament.name, date: plan.localDate, connectionId: plan.connectionId, sentAt };
      try {
        lastTournamentPost.set(leagueId, now().getTime());
        const { tournamentId } = await tournamentGateway(plan.connectionId).createTournament(plan.tournament);
        setTournamentItem(row.id, item.position, { outcome: 'created', tournamentId });
        t.recordCreated(leagueId, plannedId, tournamentId);
        created.push({ position: item.position, plannedId, tournamentId, connectionId: plan.connectionId });
        step(`Created ${item.label}.`);
      } catch (err) {
        if (err instanceof TypeError) {
          setTournamentItem(row.id, item.position, { outcome: 'failed', errorCode: 'invalid_input', error: err.message });
          t.recordFailed(leagueId, plannedId, 'invalid_input');
          step(`${item.label}: invalid_input.`);
          continue;
        }
        if (!(err instanceof PokemonUpstreamError)) throw err;
        if (err.code === 'unavailable' || err.code === 'unexpected_shape') {
          emit(row, 'retrying', `${err.message} Waiting to see whether play-tools created it anyway; it is never sent twice.`, done, total);
          const landed = await settle(plan);
          if (landed) {
            setTournamentItem(row.id, item.position, { outcome: 'created', tournamentId: landed });
            t.recordCreated(leagueId, plannedId, landed);
            created.push({ position: item.position, plannedId, tournamentId: landed, connectionId: plan.connectionId });
            step(`Created ${item.label}.`);
          } else {
            setTournamentItem(row.id, item.position, {
              outcome: 'unknown',
              errorCode: err.code,
              error: `${err.message} The tournament may still appear in play-tools: the app links it when it does. Retry create only if it doesn't.`,
              support: support(leagueId, at, err),
            });
            t.recordUnknown(leagueId, plannedId);
            step(`${item.label}: may have been created.`);
          }
          continue;
        }
        setTournamentItem(row.id, item.position, { outcome: 'refused', errorCode: err.code, error: err.message, support: support(leagueId, at, err) });
        t.recordFailed(leagueId, plannedId, err.code);
        step(`${item.label}: refused.`);
        if (CREATE_STOPS.has(err.code)) throw new TournamentStop(err.code);
      }
    }

    // Reconcile: play-tools' status for each tournament the job now holds (approval-pending is shown as it is).
    for (const c of created) {
      try {
        const details = await tournamentGateway(c.connectionId).getTournament(c.tournamentId);
        t.recordReconciled(leagueId, c.plannedId, { displayId: details.displayId, status: details.applicationState ?? details.status });
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        log.warn(`Tournament create #${row.id} could not re-read ${c.tournamentId}: ${err.code}`, { submissionId: row.id, code: err.code });
      }
    }
    const ok = created.length;
    emit(row, 'reconciled', `play-tools has ${ok} of the ${total} tournaments.`, total, total);
    const status = ok === total ? 'succeeded' : ok > 0 ? 'partial' : 'failed';
    setStatus(row, status);
    if (status === 'succeeded' && row.throughScheduleId !== null && row.throughDate !== null) {
      t.recordCreatedThrough(leagueId, row.throughScheduleId, row.throughDate);
    }
    emit(row, 'finished', `Tournament create ${status}.`, total, total);
  }

  /** A tournament job that stopped: a create sent with no answer may have landed (`unknown`); the rest are released. */
  function stopTournamentItems(row: Row): void {
    if (row.kind === 'tdf_upload') {
      stopTdfUpload(row);
      return;
    }
    if (row.kind === 'tournament_edit' || row.kind === 'tournament_cancel') {
      // An edit or a cancel is idempotent: one in flight is `unknown`, and a retry re-reads before sending it again.
      // Only the item changes: the planned row and staff wait for what the retry finds.
      const what = row.kind === 'tournament_edit' ? 'edit' : 'cancel';
      for (const item of tournamentItems(row.id)) {
        if (item.outcome !== 'pending') continue;
        setTournamentItem(
          row.id,
          item.position,
          item.sentAt ? { outcome: 'unknown', error: `The app stopped while this ${what} was in flight: it may have been applied.` } : { outcome: 'skipped' },
        );
      }
      return;
    }
    const t = creation();
    for (const item of tournamentItems(row.id)) {
      if (item.outcome !== 'pending') continue;
      if (item.sentAt) {
        setTournamentItem(row.id, item.position, { outcome: 'unknown', error: 'The app stopped while this create was in flight: it may still appear in play-tools.' });
        t.recordUnknown(row.leagueId, item.plannedTournamentId!);
      } else {
        setTournamentItem(row.id, item.position, { outcome: 'skipped' });
        t.release(row.leagueId, item.plannedTournamentId!);
      }
    }
  }

  /**
   * Starts a `tournament_create` job: the rows are checked, then held, the job inserted and the lease taken in one
   * transaction, with no await in between.
   */
  async function beginTournamentCreate(
    leagueId: string,
    input: {
      plannedIds: readonly number[];
      acknowledgeShortNotice: boolean;
      retryUnknown: boolean;
      actor: Actor;
      label?: string;
      through?: { scheduleId: number; date: string };
      /** A retry: rows short notice now must have been in the original job. */
      wasShortNotice?: ReadonlySet<number>;
    },
    retryOf: number | null,
  ): Promise<{ submissionId: number; refused: CreateRefusal[] }> {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    assertUnlocked(leagueId);
    const t = creation();
    const { targets, refused } = t.prepare(
      leagueId,
      input.plannedIds,
      { retryUnknown: input.retryUnknown, acknowledgeShortNotice: input.acknowledgeShortNotice },
      input.actor,
    );
    if (input.wasShortNotice) {
      const newly = targets.filter((x) => x.shortNotice && !input.wasShortNotice!.has(x.plannedId)).map((x) => x.plannedId);
      if (newly.length > 0) {
        throw new TournamentsError('short_notice_not_acknowledged', 'Some are now less than 7 days away. Create them from Upcoming to acknowledge it.', {
          plannedTournamentIds: newly,
        });
      }
    }
    const organizers = new Set(targets.map((x) => x.organizer.playerId));
    const only = organizers.size === 1 ? targets[0]!.organizer : null;
    const row = db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: dateIn(now(), timeZone),
          playSessionId: '',
          playSessionLabel: input.label ?? `Create ${targets.length} ${targets.length === 1 ? 'tournament' : 'tournaments'}`,
          startedBy: input.actor.username,
          professorPlayerId: only?.playerId ?? null,
          professorName: only?.name ?? null,
          startedAt: now(),
          status: 'planned',
          retryOf,
          kind: 'tournament_create',
          throughScheduleId: input.through?.scheduleId ?? null,
          throughDate: input.through?.date ?? null,
        })
        .returning()
        .get();
      acquireLock(leagueId, created.id);
      t.hold(
        leagueId,
        targets.map((x) => x.plannedId),
      );
      db.insert(submissionTournamentItem)
        .values(
          targets.map((x, position) => ({
            submissionId: created.id,
            position,
            plannedTournamentId: x.plannedId,
            label: x.label,
            outcome: 'pending' as const,
            shortNotice: x.shortNotice,
          })),
        )
        .run();
      return created;
    });
    launch(row);
    return { submissionId: row.id, refused };
  }

  function editing(): TournamentEditing {
    if (!deps.tournaments?.editing) throw new Error('This app was built without the tournaments module.');
    return deps.tournaments.editing;
  }

  type ItemRow = typeof submissionTournamentItem.$inferSelect;

  const editItemOf = (i: ItemRow): EditItem => ({
    plannedId: i.plannedTournamentId,
    tournamentId: i.tournamentId!,
    label: i.label,
    changes: (i.changes ?? {}) as EditItem['changes'],
    professorPlayerId: i.professorPlayerId!,
    shortNotice: i.shortNotice,
  });

  /** Inserts a `tournament_edit` job and its items and takes the lease; `local` runs in the same transaction. */
  function insertEditJob(leagueId: string, input: { label: string; items: readonly EditItem[]; startedBy: string; retryOf: number | null; local?: () => number }) {
    const organizers = new Set(input.items.map((i) => i.professorPlayerId));
    const only = organizers.size === 1 ? deps.connections.listActingConnections().find((c) => c.professorPlayerId === input.items[0]!.professorPlayerId) : undefined;
    return db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: dateIn(now(), timeZone),
          playSessionId: '',
          playSessionLabel: input.label,
          startedBy: input.startedBy,
          professorPlayerId: organizers.size === 1 ? input.items[0]!.professorPlayerId : null,
          professorName: only?.professorName ?? null,
          startedAt: now(),
          status: 'planned',
          retryOf: input.retryOf,
          kind: 'tournament_edit',
        })
        .returning()
        .get();
      acquireLock(leagueId, created.id);
      const updatedLocally = input.local?.() ?? 0;
      db.insert(submissionTournamentItem)
        .values(
          input.items.map((x, position) => ({
            submissionId: created.id,
            position,
            plannedTournamentId: x.plannedId,
            tournamentId: x.tournamentId,
            label: x.label,
            outcome: 'pending' as const,
            shortNotice: x.shortNotice,
            changes: x.changes,
            professorPlayerId: x.professorPlayerId,
          })),
        )
        .run();
      return { row: created, updatedLocally };
    });
  }

  /** **Edit…**: the local writes, and a job for what is in play-tools, together (ADR-0010 decision 11). */
  async function beginTournamentEdit(leagueId: string, input: { target: EditTarget; body: ApplyBody; actor: Actor }) {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    const e = editing();
    const startedBy = input.actor.username;
    const plan = await e.prepare(leagueId, input.target, input.body, input.actor);
    if (plan.items.length === 0) return { submissionId: null, updatedLocally: db.transaction(() => e.applyLocal(leagueId, plan, startedBy)) };
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    const { row, updatedLocally } = insertEditJob(leagueId, {
      label: plan.label,
      items: plan.items,
      startedBy,
      retryOf: null,
      local: () => e.applyLocal(leagueId, plan, startedBy),
    });
    launch(row);
    return { submissionId: row.id, updatedLocally };
  }

  /** Retry of an edit job: the items it didn't get through, with the same changes; each re-reads first. */
  function retryTournamentEdit(row: Row, actor: Actor): { submissionId: number } {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    const e = editing();
    const startedBy = actor.username;
    const open = tournamentItems(row.id).filter((i) => i.outcome !== 'edited' && i.outcome !== 'already_applied');
    if (open.length === 0) throw new TournamentsError('nothing_to_edit', 'Every tournament of this job has the edit.');
    const items = open.map(editItemOf);
    // A retry is a new start by whoever clicks it, checked again (ADR-0015 §4).
    for (const i of items) assertMayActAs(deps.connections, actor, i.professorPlayerId);
    const newly = items.filter((i) => !i.shortNotice && i.changes.localDate !== undefined && e.isShortNotice(i.changes.localDate));
    if (newly.length > 0) {
      throw new TournamentsError('short_notice_not_acknowledged', 'The new date is now less than 7 days away. Edit it again to acknowledge it.', {
        plannedTournamentIds: newly.flatMap((i) => (i.plannedId === null ? [] : [i.plannedId])),
      });
    }
    const { row: created } = insertEditJob(row.leagueId, { label: row.playSessionLabel, items, startedBy, retryOf: row.id });
    launch(created);
    return { submissionId: created.id };
  }

  /**
   * `tournament_edit` (ADR-0010 decisions 8 and 11): for each tournament in start order, as its organizer, a fresh
   * read, then one `PATCH` with only the fields that differ, paced. A 5xx is settled by one re-read, never resent.
   */
  async function runTournamentEdit(row: Row): Promise<void> {
    const { leagueId } = row;
    const e = editing();
    setStatus(row, 'running');
    const items = tournamentItems(row.id);
    const total = items.length;
    let done = 0;
    emit(row, 'planned', `${total} ${total === 1 ? 'tournament' : 'tournaments'} to edit.`, 0, total);
    /** Each tournament the edit reached, and the connection to re-read it as. */
    const landed: { position: number; plannedId: number | null; tournamentId: string; connectionId: number }[] = [];
    const step = (message: string) => {
      done += 1;
      emit(row, 'tournament_sent', message, done, total);
    };

    /** Keeps PATCHes at least `tournamentDelayMs` apart across the league's tournament jobs; stops on shutdown. */
    async function pace(): Promise<void> {
      if (stop.signal.aborted) throw stop.signal.reason;
      const last = lastTournamentPost.get(leagueId);
      const wait = last === undefined ? 0 : last + tournamentDelayMs - now().getTime();
      renewLock(row, Math.max(0, wait));
      if (wait > 0) await sleep(wait, stop.signal);
    }

    function land(item: ItemRow, it: EditItem, read: Extract<ItemRead, { kind: 'send' | 'already_applied' }>, outcome: 'edited' | 'already_applied') {
      setTournamentItem(row.id, item.position, { outcome, errorCode: null, error: null });
      e.recordEdited(leagueId, it, read);
      landed.push({ position: item.position, plannedId: it.plannedId, tournamentId: it.tournamentId, connectionId: read.connectionId });
    }

    for (const item of items) {
      if (item.outcome !== 'pending') continue;
      if (stop.signal.aborted) throw stop.signal.reason;
      renewLock(row);
      const it = editItemOf(item);
      const name = item.label.replace(/ · \d{4}-\d{2}-\d{2}$/, '');
      const date = item.label.slice(-10);

      let read: ItemRead;
      try {
        read = await e.readItem(leagueId, it);
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        setTournamentItem(row.id, item.position, { outcome: 'refused', errorCode: err.code, error: err.message });
        step(`${item.label}: ${err.code}.`);
        throw new TournamentStop(err.code);
      }
      if (read.kind === 'already_applied') {
        land(item, it, read, 'already_applied');
        step(`${item.label}: already in play-tools.`);
        continue;
      }
      if (read.kind === 'fail') {
        const windowed = read.code === 'date_too_far_past' || read.code === 'date_too_far_ahead';
        setTournamentItem(row.id, item.position, {
          outcome: windowed ? (read.code as 'date_too_far_past' | 'date_too_far_ahead') : 'failed',
          errorCode: read.code,
          error: read.message,
          ...(read.error &&
            read.connectionId !== undefined && { support: support(leagueId, { name, date, connectionId: read.connectionId, sentAt: null, action: 'edit' }, read.error) }),
        });
        step(`${item.label}: ${read.code}.`);
        continue;
      }

      await pace();
      // The creatable window again, with the job's clock: a reschedule can fall out of it at midnight (#100).
      const problem = read.reschedule && read.localDate ? e.windowProblem(read.localDate) : null;
      if (problem) {
        setTournamentItem(row.id, item.position, { outcome: problem, errorCode: problem, error: `${read.localDate} is no longer in the creatable window.` });
        step(`${item.label}: ${problem}.`);
        continue;
      }
      const sentAt = now();
      setTournamentItem(row.id, item.position, { sentAt });
      const at = { name, date, connectionId: read.connectionId, sentAt, action: read.reschedule ? ('reschedule' as const) : ('edit' as const), displayId: read.read.displayId };
      try {
        lastTournamentPost.set(leagueId, now().getTime());
        await tournamentGateway(read.connectionId).editTournament(it.tournamentId, read.delta);
        land(item, it, read, 'edited');
        step(`Edited ${item.label}.`);
      } catch (err) {
        if (err instanceof TypeError) {
          setTournamentItem(row.id, item.position, { outcome: 'failed', errorCode: 'invalid_input', error: err.message });
          step(`${item.label}: invalid_input.`);
          continue;
        }
        if (!(err instanceof PokemonUpstreamError)) throw err;
        if (err.code === 'unavailable' || err.code === 'unexpected_shape') {
          emit(row, 'retrying', `${err.message} Reading the tournament again to see whether the edit landed; it is never sent twice.`, done, total);
          let again: ItemRead | null = null;
          try {
            again = await e.readItem(leagueId, it);
          } catch (readErr) {
            if (!(readErr instanceof PokemonUpstreamError)) throw readErr;
          }
          if (again?.kind === 'already_applied') {
            land(item, it, again, 'edited');
            step(`Edited ${item.label}.`);
          } else {
            setTournamentItem(row.id, item.position, {
              outcome: 'failed',
              errorCode: 'unavailable',
              error: `${err.message} play-tools doesn't show the change. Retry to send it again; the retry reads first.`,
              support: support(leagueId, at, err),
            });
            step(`${item.label}: unavailable.`);
          }
          continue;
        }
        const outcome = err.code === 'tournament_locked' ? 'failed' : 'refused';
        setTournamentItem(row.id, item.position, { outcome, errorCode: err.code, error: err.message, support: support(leagueId, at, err) });
        step(`${item.label}: ${outcome}.`);
        if (CREATE_STOPS.has(err.code)) throw new TournamentStop(err.code);
      }
    }

    // Reconcile: play-tools' status for each edited tournament; a reschedule may send it back for approval.
    for (const l of landed) {
      try {
        const details = await tournamentGateway(l.connectionId).getTournament(l.tournamentId);
        const status = details.applicationState ?? details.status;
        if (l.plannedId !== null) e.recordReconciled(leagueId, l.plannedId, { displayId: details.displayId, status });
        if (status === 'approval-pending' || status === 'sanctioning-error') {
          setTournamentItem(row.id, l.position, { error: `play-tools now shows this tournament as ${status}: it may need approval again.` });
        }
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        log.warn(`Tournament edit #${row.id} could not re-read ${l.tournamentId}: ${err.code}`, { submissionId: row.id, code: err.code });
      }
    }
    const ok = landed.length;
    emit(row, 'reconciled', `play-tools has the edit on ${ok} of the ${total} tournaments.`, total, total);
    const status = ok === total ? 'succeeded' : ok > 0 ? 'partial' : 'failed';
    setStatus(row, status);
    emit(row, 'finished', `Tournament edit ${status}.`, total, total);
  }

  function cancelling(): TournamentCancelling {
    if (!deps.tournaments?.cancelling) throw new Error('This app was built without the tournaments module.');
    return deps.tournaments.cancelling;
  }

  const cancelItemOf = (i: ItemRow): CancelItem => ({
    plannedId: i.plannedTournamentId,
    tournamentId: i.tournamentId!,
    label: i.label,
    professorPlayerId: i.professorPlayerId!,
    confirmed: (i.changes as { confirmed?: boolean } | null)?.confirmed === true,
  });

  /** Inserts a `tournament_cancel` job and its one item, and takes the lease, in one transaction. */
  function insertCancelJob(leagueId: string, input: { item: CancelItem; startedBy: string; retryOf: number | null }): Row {
    const organizer = deps.connections.listActingConnections().find((c) => c.professorPlayerId === input.item.professorPlayerId);
    return db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: dateIn(now(), timeZone),
          playSessionId: '',
          playSessionLabel: `Cancel ${input.item.label}`,
          startedBy: input.startedBy,
          professorPlayerId: input.item.professorPlayerId,
          professorName: organizer?.professorName ?? null,
          startedAt: now(),
          status: 'planned',
          retryOf: input.retryOf,
          kind: 'tournament_cancel',
        })
        .returning()
        .get();
      acquireLock(leagueId, created.id);
      db.insert(submissionTournamentItem)
        .values({
          submissionId: created.id,
          position: 0,
          plannedTournamentId: input.item.plannedId,
          tournamentId: input.item.tournamentId,
          label: input.item.label,
          outcome: 'pending',
          changes: { confirmed: input.item.confirmed },
          professorPlayerId: input.item.professorPlayerId,
        })
        .run();
      return created;
    });
  }

  /**
   * **Cancel…** (ADR-0010 decision 8): fresh reads and the typed confirmation, then a job. One play-tools already
   * cancelled is cancelled locally with no job, under the same lease check, and logged, since History won't show it.
   */
  async function beginTournamentCancel(leagueId: string, input: { target: EditTarget; body: CancelBody; actor: Actor }) {
    const shuttingDown = () => new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    if (stop.signal.aborted) throw shuttingDown();
    assertUnlocked(leagueId);
    const c = cancelling();
    const startedBy = input.actor.username;
    const plan = await c.prepare(leagueId, input.target, input.body, input.actor);
    if (stop.signal.aborted) throw shuttingDown();
    if (plan.kind === 'already_cancelled') {
      const { dropped, removed } = db.transaction(() => {
        assertUnlocked(leagueId);
        return c.recordCancelled(leagueId, plan.item);
      });
      log.info(`${plan.item.label} was already cancelled in play-tools: cancelled here too`, {
        by: startedBy,
        tournamentId: plan.item.tournamentId,
        plannedTournamentId: plan.item.plannedId,
        dropped,
        removed,
      });
      return { submissionId: null, outcome: 'already_cancelled' as const };
    }
    const row = insertCancelJob(leagueId, { item: plan.item, startedBy, retryOf: null });
    launch(row);
    return { submissionId: row.id };
  }

  /** Retry of a cancel job: its item again, confirmed or not as it was; the job re-reads first. */
  function retryTournamentCancel(row: Row, actor: Actor): { submissionId: number } {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    const open = tournamentItems(row.id).find((i) => i.outcome !== 'cancelled' && i.outcome !== 'already_cancelled');
    if (!open) throw new TournamentsError('nothing_to_cancel', 'play-tools already has this tournament cancelled.');
    const item = cancelItemOf(open);
    assertMayActAs(deps.connections, actor, item.professorPlayerId);
    const created = insertCancelJob(row.leagueId, { item, startedBy: actor.username, retryOf: row.id });
    launch(created);
    return { submissionId: created.id };
  }

  /**
   * `tournament_cancel` (ADR-0010 decision 8): a fresh read as the organizer, then one `PATCH`, paced with the league's
   * other tournament writes. A 5xx is settled by one re-read, never resent. Then the planned row and staff follow
   * locally, and a last read records play-tools' status.
   */
  async function runTournamentCancel(row: Row): Promise<void> {
    const { leagueId } = row;
    const c = cancelling();
    setStatus(row, 'running');
    const items = tournamentItems(row.id);
    const total = items.length;
    let done = 0;
    emit(row, 'planned', 'One tournament to cancel.', 0, total);
    const step = (message: string) => {
      done += 1;
      emit(row, 'tournament_sent', message, done, total);
    };

    async function pace(): Promise<void> {
      if (stop.signal.aborted) throw stop.signal.reason;
      const last = lastTournamentPost.get(leagueId);
      const wait = last === undefined ? 0 : last + tournamentDelayMs - now().getTime();
      renewLock(row, Math.max(0, wait));
      if (wait > 0) await sleep(wait, stop.signal);
    }

    let landed: { position: number; it: CancelItem; connectionId: number } | null = null;
    for (const item of items) {
      if (item.outcome !== 'pending') continue;
      if (stop.signal.aborted) throw stop.signal.reason;
      renewLock(row);
      const it = cancelItemOf(item);
      const name = item.label.replace(/ · \d{4}-\d{2}-\d{2}$/, '');
      const date = item.label.match(/\d{4}-\d{2}-\d{2}$/)?.[0] ?? '';

      const settle = (outcome: 'cancelled' | 'already_cancelled', connectionId: number) => {
        c.recordCancelled(leagueId, it);
        setTournamentItem(row.id, item.position, { outcome, errorCode: null, error: null });
        if (outcome === 'cancelled') landed = { position: item.position, it, connectionId };
      };

      // Wait its turn first, so the read that decides the cancel is the last thing before it: nobody registers unseen.
      await pace();
      let read: CancelRead;
      try {
        read = await c.readItem(leagueId, it);
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        const stops = CREATE_STOPS.has(err.code);
        setTournamentItem(row.id, item.position, { outcome: stops ? 'refused' : 'failed', errorCode: err.code, error: err.message });
        step(`${item.label}: ${err.code}.`);
        if (stops) throw new TournamentStop(err.code);
        continue;
      }
      if (read.kind === 'already_cancelled') {
        settle('already_cancelled', read.connectionId);
        step(`${item.label}: already cancelled in play-tools.`);
        continue;
      }
      if (read.kind === 'fail') {
        setTournamentItem(row.id, item.position, { outcome: 'failed', errorCode: read.code, error: read.message });
        step(`${item.label}: ${read.code}.`);
        continue;
      }

      const sentAt = now();
      setTournamentItem(row.id, item.position, { sentAt });
      const at = { name, date, connectionId: read.connectionId, sentAt, action: 'cancel' as const, displayId: read.read.displayId };
      try {
        lastTournamentPost.set(leagueId, now().getTime());
        await tournamentGateway(read.connectionId).cancelTournament(it.tournamentId);
        settle('cancelled', read.connectionId);
        step(`Cancelled ${item.label}.`);
      } catch (err) {
        if (err instanceof TypeError) {
          setTournamentItem(row.id, item.position, { outcome: 'failed', errorCode: 'invalid_input', error: err.message });
          step(`${item.label}: invalid_input.`);
          continue;
        }
        if (!(err instanceof PokemonUpstreamError)) throw err;
        if (err.code === 'unavailable' || err.code === 'unexpected_shape') {
          emit(row, 'retrying', `${err.message} Reading the tournament again to see whether the cancel landed; it is never sent twice.`, done, total);
          let again: CancelRead | null = null;
          try {
            again = await c.readItem(leagueId, it);
          } catch (readErr) {
            if (!(readErr instanceof PokemonUpstreamError)) throw readErr;
          }
          if (again?.kind === 'already_cancelled') {
            settle('cancelled', again.connectionId);
            step(`Cancelled ${item.label}.`);
          } else {
            setTournamentItem(row.id, item.position, {
              outcome: 'failed',
              errorCode: 'unavailable',
              error: `${err.message} play-tools doesn't show it cancelled. Retry to send it again; the retry reads first.`,
              support: support(leagueId, at, err),
            });
            step(`${item.label}: unavailable.`);
          }
          continue;
        }
        const outcome = err.code === 'tournament_locked' ? 'failed' : 'refused';
        setTournamentItem(row.id, item.position, { outcome, errorCode: err.code, error: err.message, support: support(leagueId, at, err) });
        step(`${item.label}: ${outcome}.`);
        if (CREATE_STOPS.has(err.code)) throw new TournamentStop(err.code);
      }
    }

    // Reconcile, after the local follow-ups: play-tools' own status goes on the row, whatever it says.
    const l = landed as { position: number; it: CancelItem; connectionId: number } | null;
    if (l) {
      try {
        const details = await tournamentGateway(l.connectionId).getTournament(l.it.tournamentId);
        const status = details.applicationState ?? details.status;
        if (l.it.plannedId !== null) c.recordReconciled(leagueId, l.it.plannedId, { displayId: details.displayId, status });
        if (status !== 'cancelled') {
          setTournamentItem(row.id, l.position, { error: `play-tools answered the cancel, but still shows this tournament as ${status}.` });
        }
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        log.warn(`Tournament cancel #${row.id} could not re-read ${l.it.tournamentId}: ${err.code}`, { submissionId: row.id, code: err.code });
      }
    }
    const finalItems = tournamentItems(row.id);
    const ok = finalItems.every((i) => i.outcome === 'cancelled' || i.outcome === 'already_cancelled');
    // A tournament cancelled through the app can't stay lent (ADR-0015 §5). Its lease's ending never fails the job.
    if (ok) {
      for (const i of finalItems) {
        try {
          if (i.tournamentId) deps.leases?.endLeasesForTournament(i.tournamentId, 'tournament_cancelled');
        } catch (err) {
          log.warn(`Tournament cancel #${row.id} could not end the lease on ${i.tournamentId}: ${(err as Error).message}`, { submissionId: row.id });
        }
      }
    }
    const status = ok ? 'succeeded' : 'failed';
    emit(row, 'reconciled', ok ? 'play-tools has the tournament cancelled.' : "play-tools doesn't have the tournament cancelled.", total, total);
    setStatus(row, status);
    emit(row, 'finished', `Tournament cancel ${status}.`, total, total);
  }

  // --- TDF results upload (#96, ADR-0011) ---------------------------------------

  function results(): TournamentResults {
    if (!deps.tournaments?.results) throw new Error('This app was built without the tournaments module.');
    return deps.tournaments.results;
  }

  /**
   * The confirm (ADR-0011 decision 4): its fingerprint checked against the preview's, then the `tdf_upload` job, its
   * item, the upload marked `sending` and the lease, in one transaction.
   */
  async function beginTdfUpload(
    leagueId: string,
    input: { date: SessionDate; tournamentId: string; uploadId: number; body: ResultsConfirmBody; actor: Actor },
  ): Promise<{ submissionId: number }> {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    const r = results();
    const startedBy = input.actor.username;
    const plan: ConfirmPlan = r.prepareConfirm(leagueId, input.date, input.tournamentId, input.uploadId, input.body, input.actor);
    const organizer = deps.connections.listActingConnections().find((c) => c.professorPlayerId === plan.professorPlayerId);
    const row = db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: plan.date,
          playSessionId: '',
          playSessionLabel: `Upload results ${plan.label}`,
          startedBy,
          professorPlayerId: plan.professorPlayerId,
          professorName: organizer?.professorName ?? null,
          startedAt: now(),
          status: 'planned',
          retryOf: null,
          kind: 'tdf_upload',
          resultsUploadId: plan.uploadId,
          leaseId: plan.leaseId,
        })
        .returning()
        .get();
      acquireLock(leagueId, created.id);
      if (!r.markSending(plan.uploadId, { by: startedBy, fingerprint: input.body.acknowledgedWarnings, submissionId: created.id })) {
        throw new TournamentsError('upload_not_open', 'This upload was already sent or closed. Use Upload again….', { state: r.peek(plan.uploadId)?.state ?? null });
      }
      db.insert(submissionTournamentItem)
        .values({
          submissionId: created.id,
          position: 0,
          plannedTournamentId: null,
          tournamentId: plan.tournamentId,
          label: plan.label,
          outcome: 'pending',
          changes: { importAttendance: plan.importAttendance },
          professorPlayerId: plan.professorPlayerId,
        })
        .run();
      return created;
    });
    launch(row);
    return { submissionId: row.id };
  }

  /**
   * `tdf_upload` (ADR-0011 decisions 4 and 7): paced, then a fresh check as the organizer just before the send; validate
   * (the send: Pokémon support gets a copy), confirm only if play-tools accepted the file, commit attendance, then end.
   * Nothing is ever sent twice: a 5xx on validate is `validate_unknown`, and one on confirm is settled by a read.
   */
  async function runTdfUpload(row: Row): Promise<void> {
    const { leagueId } = row;
    const uploadId = row.resultsUploadId!;
    const r = results();
    setStatus(row, 'running');
    const item = tournamentItems(row.id)[0]!;
    const importAttendance = (item.changes as { importAttendance?: boolean } | null)?.importAttendance === true;
    const name = item.label.replace(/ · \d{4}-\d{2}-\d{2}$/, '');
    const date = row.sessionDate;
    emit(row, 'planned', 'One file to upload.', 0, 1);

    const end = (outcome: TournamentItemOutcome, set: Partial<typeof submissionTournamentItem.$inferInsert> = {}, upload: Parameters<TournamentResults['record']>[1] = {}) => {
      r.record(uploadId, upload);
      setTournamentItem(row.id, item.position, { outcome, ...set });
      emit(row, 'tournament_sent', `${item.label}: ${outcome}.`, 1, 1);
    };

    const endLeaseEnded = () => {
      end('failed', { errorCode: 'lease_ended', error: 'The lease on this tournament ended before the file was sent. Nothing was sent.' }, { state: 'failed', errorCode: 'lease_ended' });
      return finishTdfUpload(row, false);
    };
    if (leaseEnded(row)) return endLeaseEnded();

    // Wait its turn first, so the check that decides the send is the last thing before it.
    if (stop.signal.aborted) throw stop.signal.reason;
    const last = lastTournamentPost.get(leagueId);
    const wait = last === undefined ? 0 : last + tournamentDelayMs - now().getTime();
    renewLock(row, Math.max(0, wait));
    if (wait > 0) await sleep(wait, stop.signal);

    let check: Awaited<ReturnType<TournamentResults['jobCheck']>>;
    try {
      check = await r.jobCheck(leagueId, uploadId);
    } catch (err) {
      if (!(err instanceof PokemonUpstreamError)) throw err;
      end('failed', { errorCode: err.code, error: err.message }, { state: 'failed', errorCode: err.code });
      return finishTdfUpload(row, false);
    }
    if (stop.signal.aborted) throw stop.signal.reason;
    if (check.kind === 'blocked') {
      const refused = check.code === 'results_already_uploaded' || check.code === 'results_not_accepted';
      end(refused ? 'refused' : 'failed', { errorCode: check.code, error: check.message }, { state: 'failed', errorCode: check.code });
      return finishTdfUpload(row, false);
    }
    if (check.kind === 'warnings_changed') {
      end('warnings_changed', { error: 'The warnings changed since they were shown. Nothing was sent. Use Upload again… to check them.' }, { state: 'warnings_changed' });
      return finishTdfUpload(row, false);
    }
    // A leased send checks its lease once more right before the validate; after it, the confirm always finishes (ADR-0015 §5).
    if (leaseEnded(row)) return endLeaseEnded();

    const { connectionId } = check;
    const g = tournamentGateway(connectionId);
    const sentAt = now();
    setTournamentItem(row.id, item.position, { sentAt });
    r.markKept(uploadId);
    const at = { name, date, connectionId, sentAt, action: 'upload' as const, displayId: check.displayId };
    renewLock(row);
    lastTournamentPost.set(leagueId, now().getTime());
    let validated: { uploadId: string; errors: readonly { code: string; message: string; detail: string | null }[] };
    try {
      validated = await g.validateResults(check.displayId, check.content);
    } catch (err) {
      if (err instanceof TypeError) {
        end('failed', { errorCode: 'invalid_input', error: err.message }, { state: 'failed', errorCode: 'invalid_input' });
        return finishTdfUpload(row, false);
      }
      if (!(err instanceof PokemonUpstreamError)) throw err;
      if (err.code === 'unavailable' || err.code === 'unexpected_shape' || err.code === 'rate_limited') {
        end(
          'validate_unknown',
          {
            errorCode: err.code,
            error: "We couldn't tell whether play-tools received this file. Pokémon support may have a copy. Check the tournament in play-tools before you upload again.",
            support: support(leagueId, at, err),
          },
          { state: 'validate_unknown', errorCode: err.code },
        );
      } else {
        end('refused', { errorCode: err.code, error: err.message, support: support(leagueId, at, err) }, { state: 'failed', errorCode: err.code });
      }
      return finishTdfUpload(row, importAttendance);
    }
    const errors = [...validated.errors];
    r.record(uploadId, { upstreamUploadId: validated.uploadId, upstreamErrors: errors });
    const details = { ...support(leagueId, at), uploadGuid: validated.uploadId, errors: errors.map((e) => e.code) };
    if (errors.length > 0) {
      end(
        'not_accepted',
        { error: 'play-tools did not accept this file. Pokémon support can access the file from this failed attempt.', support: details },
        { state: 'not_accepted' },
      );
      return finishTdfUpload(row, importAttendance);
    }

    // Recorded before the confirm goes out: a crash after it is settled on read, never confirmed twice (ADR-0011 Update #96).
    r.record(uploadId, { state: 'processing' });
    try {
      await g.confirmResults(validated.uploadId, check.tournamentId);
      end('processing', { errorCode: null, error: null });
    } catch (err) {
      if (!(err instanceof PokemonUpstreamError)) throw err;
      if (err.code === 'unavailable' || err.code === 'unexpected_shape') {
        emit(row, 'retrying', `${err.message} Reading the tournament to see whether the confirm landed; it is never sent twice.`, 0, 1);
        const state = await r.follow(leagueId, uploadId);
        if (state === 'failed') {
          end('failed', { errorCode: 'confirm_not_landed', error: "play-tools doesn't show this upload confirmed. Use Upload again….", support: { ...support(leagueId, at, err), uploadGuid: validated.uploadId } });
        } else {
          end(state === 'complete' ? 'uploaded' : 'processing', { errorCode: null, error: null });
        }
      } else {
        end('failed', { errorCode: err.code, error: err.message, support: { ...support(leagueId, at, err), uploadGuid: validated.uploadId } }, { state: 'failed', errorCode: err.code });
      }
    }
    return finishTdfUpload(row, importAttendance);
  }

  /** After the send was attempted: the attendance import (if ticked), then the job's status. The lease is freed after. */
  function finishTdfUpload(row: Row, commitAttendance: boolean): void {
    const item = tournamentItems(row.id)[0]!;
    let attendanceFailed = false;
    if (commitAttendance) {
      try {
        results().commitAttendance(row.leagueId, row.resultsUploadId!);
      } catch (err) {
        attendanceFailed = true;
        const note = `attendance not imported: ${(err as Error).message}`;
        setTournamentItem(row.id, item.position, { error: item.error ? `${item.error} (${note})` : note });
        log.warn(`Results upload #${row.id} could not import attendance: ${(err as Error).message}`, { submissionId: row.id });
      }
    }
    const sent = item.outcome === 'processing' || item.outcome === 'uploaded';
    const status = sent ? (attendanceFailed ? 'partial' : 'succeeded') : 'failed';
    emit(row, 'reconciled', sent ? 'play-tools is processing the results.' : "play-tools didn't take the results.", 1, 1);
    setStatus(row, status);
    emit(row, 'finished', `Results upload ${status}.`, 1, 1);
  }

  /**
   * A `tdf_upload` stopped by a crash or shutdown: a validate with no answer is `validate_unknown`, a confirm
   * that went out is `processing` (settled on read), anything earlier is skipped. Nothing is sent.
   */
  function stopTdfUpload(row: Row): void {
    const item = tournamentItems(row.id)[0];
    if (!item || item.outcome !== 'pending' || row.resultsUploadId === null) return;
    const r = results();
    const upload = r.peek(row.resultsUploadId);
    if (upload?.state === 'processing') {
      setTournamentItem(row.id, item.position, { outcome: 'processing' });
    } else if (upload && upload.state !== 'sending' && upload.state !== 'previewed') {
      // The upload recorded how it ended just before the crash: the item follows it.
      const settled: Partial<Record<UploadState, TournamentItemOutcome>> = {
        not_accepted: 'not_accepted',
        warnings_changed: 'warnings_changed',
        validate_unknown: 'validate_unknown',
        complete: 'uploaded',
        failed: 'failed',
      };
      setTournamentItem(row.id, item.position, { outcome: settled[upload.state] ?? 'failed', errorCode: upload.errorCode });
    } else if (item.sentAt && !upload?.upstreamUploadId) {
      setTournamentItem(row.id, item.position, {
        outcome: 'validate_unknown',
        error: 'The app stopped while play-tools was validating this file. Pokémon support may have a copy. Check the tournament in play-tools before you upload again.',
      });
      r.record(row.resultsUploadId, { state: 'validate_unknown' });
    } else {
      setTournamentItem(row.id, item.position, { outcome: 'skipped' });
      r.record(row.resultsUploadId, { state: 'failed', errorCode: 'interrupted' });
    }
  }

  // --- Remove from staff (#96, ADR-0007 update) ------------------------------

  /** Inserts a removal-only staff job and its items, and takes the lease, in one transaction. */
  function insertRemovalJob(leagueId: string, input: { plan: RemovalPlan; startedBy: string; retryOf: number | null }): Row {
    const { plan } = input;
    const organizer = deps.connections.listActingConnections().find((c) => c.professorPlayerId === plan.professorPlayerId);
    return db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: plan.date,
          playSessionId: plan.tournamentId,
          playSessionLabel: `${STAFF_PREFIX}${plan.label}`,
          startedBy: input.startedBy,
          professorPlayerId: plan.professorPlayerId,
          professorName: organizer?.professorName ?? null,
          startedAt: now(),
          status: 'planned',
          retryOf: input.retryOf,
          kind: 'staff',
          resultsUploadId: plan.uploadId,
          leaseId: plan.leaseId,
        })
        .returning()
        .get();
      acquireLock(leagueId, created.id);
      deps.roster.ensurePlayers(
        leagueId,
        plan.playerIds.map((playerId) => ({ playerId })),
      );
      setItems(plan.playerIds.map((playerId) => ({ submissionId: created.id, playerId, origin: 'upstream' as const, outcome: 'pending' as const })));
      return created;
    });
  }

  /** A History retry of a removal job: the checks again for its players not removed yet, then a new removal job. */
  async function retryStaffRemoval(row: Row, actor: Actor): Promise<{ submissionId: number }> {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    const left = db
      .select({ playerId: submissionItem.playerId, outcome: submissionItem.outcome })
      .from(submissionItem)
      .where(eq(submissionItem.submissionId, row.id))
      .all()
      .filter((i) => !GONE.includes(i.outcome))
      .map((i) => i.playerId as PlayerId);
    if (left.length === 0) throw new TournamentsError('nothing_to_retry', 'Everyone this job named is off the staff already.');
    assertUnlocked(row.leagueId);
    const plan = await results().checkRemovable(row.leagueId, row.sessionDate as SessionDate, row.playSessionId, row.resultsUploadId!, left, actor);
    const created = insertRemovalJob(row.leagueId, { plan, startedBy: actor.username, retryOf: row.id });
    launch(created);
    return { submissionId: created.id };
  }

  /**
   * Remove from staff (ADR-0007 update): for each named player, a fresh read; a `DELETE` of their staff record only if
   * play-tools still lists them as staff (never the organizer's), paced like any staff write. A 5xx is settled by
   * reading again before another try. Then the player is forgotten as this tournament's staff locally.
   */
  async function runStaffRemoval(row: Row): Promise<void> {
    const { leagueId } = row;
    const tournamentId = row.playSessionId;
    assertLeaseLive(row);
    const gateway = deps.staffGateway(stampedConnection(row));
    setStatus(row, 'running');
    const items = db.select().from(submissionItem).where(eq(submissionItem.submissionId, row.id)).all();
    const total = items.length;
    let done = 0;
    emit(row, 'planned', `${total} to remove.`, 0, total);

    const staffRecord = (people: readonly TournamentParticipant[], playerId: string) =>
      people.find((p) => p.playerId === playerId && p.isStaff && p.role !== 'organizer');
    async function read(): Promise<TournamentParticipant[]> {
      try {
        return await gateway.listTournamentParticipants(tournamentId);
      } catch (err) {
        if (err instanceof PokemonUpstreamError && err.code === 'not_found') throw new StaffStop('unknown_tournament');
        if (err instanceof PokemonUpstreamError && STAFF_STOPS.has(err.code)) throw new StaffStop(err.code as 'tournament_locked' | 'forbidden');
        throw err;
      }
    }
    async function pace(): Promise<void> {
      if (stop.signal.aborted) throw stop.signal.reason;
      assertLeaseLive(row);
      const lastWriteAt = lastStaffWrite.get(leagueId);
      const w = lastWriteAt === undefined ? 0 : lastWriteAt + staffDelayMs - now().getTime();
      renewLock(row, Math.max(0, w));
      if (w > 0) await sleep(w, stop.signal);
    }

    for (const item of items) {
      const playerId = item.playerId as PlayerId;
      let outcome: StaffOutcome | undefined;
      for (let tries = 0; !outcome; tries += 1) {
        await pace();
        const record = staffRecord(await read(), playerId);
        if (!record) {
          outcome = { outcome: 'already_removed' };
          break;
        }
        try {
          lastStaffWrite.set(leagueId, now().getTime());
          const result = await gateway.unassignStaff(tournamentId, record.recordId, playerId);
          outcome = { outcome: result === 'removed' ? 'removed' : 'already_removed', recordId: record.recordId };
        } catch (err) {
          if (err instanceof TypeError) outcome = { outcome: 'failed', error: err.message, errorCode: 'invalid_input' };
          else if (!(err instanceof PokemonUpstreamError)) throw err;
          else if (STAFF_STOPS.has(err.code) || CONNECTION_LOST.has(err.code)) throw err;
          else if (!err.retryable || tries >= MAX_RETRIES) outcome = { outcome: 'failed', error: err.message, errorCode: err.code };
          else emit(row, 'retrying', `${err.message} Checking whether the removal landed.`, done, total);
        }
      }
      setOutcome(row.id, [playerId], {
        outcome: outcome.outcome,
        error: outcome.error ?? null,
        errorCode: outcome.errorCode ?? null,
        ...(outcome.recordId !== undefined ? { recordId: outcome.recordId } : {}),
      });
      done += 1;
      emit(row, 'staff_sent', outcome.outcome === 'removed' ? `Removed ${playerId}.` : `${playerId}: ${outcome.outcome}.`, done, total);
    }

    finishRemovalOfStaff(row);
    const final = db.select({ outcome: submissionItem.outcome }).from(submissionItem).where(eq(submissionItem.submissionId, row.id)).all();
    const missed = final.filter((i) => !GONE.includes(i.outcome)).length;
    emit(row, 'reconciled', `${total - missed} of the ${total} are off the staff.`, total, total);
    const status = missed === 0 ? 'succeeded' : missed < total ? 'partial' : 'failed';
    setStatus(row, status);
    emit(row, 'finished', `Staff job ${status}.`, total, total);
  }

  /** Each player play-tools no longer lists as staff is forgotten as this tournament's staff here. */
  function finishRemovalOfStaff(row: Row): void {
    const gone = db
      .select()
      .from(submissionItem)
      .where(and(eq(submissionItem.submissionId, row.id), inArray(submissionItem.outcome, GONE)))
      .all();
    for (const i of gone) {
      try {
        deps.staffing.forgetPlayed(row.leagueId, row.playSessionId, i.playerId as PlayerId);
      } catch (err) {
        log.warn(`${what(row)} #${row.id} could not forget staffer ${i.playerId} locally: ${(err as Error).message}`, { submissionId: row.id });
        setOutcome(row.id, [i.playerId as PlayerId], { outcome: 'failed', error: `play-tools: ${i.outcome}; saving it here failed.`, errorCode: 'local_write_failed' });
      }
    }
  }

  function tournamentItemView(i: typeof submissionTournamentItem.$inferSelect): TournamentItemView {
    return {
      position: i.position,
      plannedTournamentId: i.plannedTournamentId,
      tournamentId: i.tournamentId,
      label: i.label,
      outcome: i.outcome,
      errorCode: i.errorCode,
      error: i.error,
      sentAt: i.sentAt?.toISOString() ?? null,
      shortNotice: i.shortNotice,
      support: (i.support as SupportDetails | null) ?? null,
    };
  }

  /** A job that stops early: whoever was not sent yet is skipped. */
  function stopEarly(row: Row, status: 'failed' | 'interrupted', error: string): void {
    db.update(submissionItem)
      .set({ outcome: 'skipped' })
      .where(and(eq(submissionItem.submissionId, row.id), eq(submissionItem.outcome, 'pending')))
      .run();
    if (row.kind === 'undo' || row.kind === 'clear') finishRemoval(row);
    if (row.kind === 'staff' && !isRemoval(row)) finishStaff(row);
    if (isRemoval(row)) finishRemovalOfStaff(row);
    if (isTournamentJob(row)) stopTournamentItems(row);
    setStatus(row, status, error);
    if (isImport(row)) {
      const r = importProgress(row);
      emit(row, 'finished', `${IMPORT_LABEL[row.kind]} ${status}: ${error}`, r.tournamentsRead + r.tournamentsFailed, r.tournamentsTotal);
      return;
    }
    const c = counts(row);
    const total = c.added + c.failed + c.skipped;
    emit(row, 'finished', `Submission ${status}: ${error}`, c.added + c.failed, total);
  }

  /** Runs a job to its end, recording how it ended; never rejects. Leaves the lease to the caller. */
  function execute(row: Row): Promise<void> {
    const submissionId = row.id;
    log.info(`${what(row)} #${submissionId} started for ${row.sessionDate}`, { submissionId, date: row.sessionDate });
    return (
      row.kind === 'undo'
        ? runUndo(row)
        : row.kind === 'clear'
          ? runClear(row)
          : row.kind === 'staff'
            ? isRemoval(row)
              ? runStaffRemoval(row)
              : runStaff(row)
            : row.kind === 'tournament_create'
              ? runTournamentCreate(row)
              : row.kind === 'tournament_edit'
              ? runTournamentEdit(row)
              : row.kind === 'tournament_cancel'
              ? runTournamentCancel(row)
              : row.kind === 'tdf_upload'
              ? runTdfUpload(row)
              : isImport(row)
              ? runImport(row)
              : run(row)
    )
      .catch((err: unknown) => {
        const interrupted = err instanceof Interrupted;
        if (!interrupted) log.warn(`${what(row)} #${submissionId} failed: ${(err as Error).message}`, { submissionId });
        // History shows an import's upstream stop as its code (forbidden, needs_reconnect, unavailable…).
        const reason = isImport(row) && err instanceof PokemonUpstreamError ? err.code : (err as Error).message;
        stopEarly(row, interrupted ? 'interrupted' : 'failed', reason);
      })
      .then(() => {
        const status = load(row.leagueId, submissionId)?.status;
        log.info(`${what(row)} #${submissionId} ${status}`, { submissionId, status });
      })
      .catch((err: unknown) => log.warn(`${what(row)} #${submissionId} could not record how it ended: ${(err as Error).message}`, { submissionId }))
      // However it ended, play-tools may have changed: coverage lists again (ADR-0010 decision 12).
      .finally(async () => {
        // Remove from staff: the preview's checks again now the job ended (ADR-0011 Update #96), best effort.
        if (isRemoval(row)) await deps.tournaments?.results?.recheckAfterStaff(row.leagueId, row.resultsUploadId!);
        if (!isTournamentJob(row)) return;
        try {
          deps.tournaments?.requiredEvents?.listingsChanged();
        } catch (err) {
          log.warn(`${what(row)} #${submissionId} could not drop coverage's cached listings: ${(err as Error).message}`, { submissionId });
        }
      });
  }

  function launch(row: Row): void {
    const job = execute(row).finally(() => {
      try {
        releaseLock(row);
      } catch {
        // The database is gone (shutdown); the lease expires on its own.
      }
      running.delete(job);
    });
    running.add(job);
  }

  /** `connection` picks who the attempt runs as, after the league check, so its refusals come in a fixed order. */
  async function begin(leagueId: string, date: SessionDate, playSessionId: string, startedBy: string, connection: () => ActingConnection, retryOf: number | null) {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    leagueGroup(deps.connections, leagueId);
    const as = connection();
    const candidate = await deps.resolver.find(leagueId, date, playSessionId, as.id);
    if (!candidate.editable) {
      throw new SubmissionError(
        'edit_window_closed',
        `play-tools stopped accepting attendance for this session on ${candidate.editableUntil?.toISOString()}.`,
      );
    }
    const draft = deps.sessions.getSession(leagueId, date);
    if (draft.players.length === 0 && draft.regulars.length === 0) {
      throw new SubmissionError('nothing_to_submit', `Nobody to submit for ${date}: add regulars or session players first.`);
    }

    const row = db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: date,
          playSessionId: candidate.id,
          playSessionLabel: candidate.label,
          startedBy,
          ...professorOf(as),
          startedAt: now(),
          status: 'planned',
          retryOf,
        })
        .returning()
        .get();
      acquireLock(leagueId, created.id);
      return created;
    });
    launch(row);
    return { submissionId: row.id };
  }

  /** Items of `target` whose added record no undo of it has removed yet. */
  function undoTargets(target: Row): (typeof submissionItem.$inferSelect)[] {
    const undone = new Set(
      db
        .select({ recordId: submissionItem.recordId })
        .from(submissionItem)
        .innerJoin(submission, eq(submission.id, submissionItem.submissionId))
        .where(and(eq(submission.undoOf, target.id), inArray(submissionItem.outcome, GONE)))
        .all()
        .map((r) => r.recordId),
    );
    return db
      .select()
      .from(submissionItem)
      .where(and(eq(submissionItem.submissionId, target.id), eq(submissionItem.outcome, 'added')))
      .all()
      .filter((i) => i.recordId !== null && !undone.has(i.recordId));
  }

  async function beginUndo(leagueId: string, target: Row, actor: Actor, retryOf: number | null): Promise<{ submissionId: number }> {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    if (target.kind !== 'submit' || ACTIVE.includes(target.status)) {
      throw new SubmissionError('not_undoable', 'Only a finished submission can be undone.');
    }
    const targets = undoTargets(target);
    if (targets.length === 0) throw new SubmissionError('nothing_to_undo', 'This submission added nobody that is still to remove.');
    // Undo removes what one professor added, as that professor (ADR-0015 §4).
    const as = originalConnection(actor, target);
    const date = target.sessionDate as SessionDate;
    const candidate = await deps.resolver.find(leagueId, date, target.playSessionId, as.id);
    if (!candidate.editable) {
      throw new SubmissionError(
        'edit_window_closed',
        `play-tools stopped accepting attendance for this session on ${candidate.editableUntil?.toISOString()}.`,
      );
    }

    const row = db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: target.sessionDate,
          playSessionId: target.playSessionId,
          playSessionLabel: target.playSessionLabel,
          startedBy: actor.username,
          ...professorOf(as),
          startedAt: now(),
          status: 'planned',
          retryOf,
          kind: 'undo',
          undoOf: target.id,
        })
        .returning()
        .get();
      acquireLock(leagueId, created.id);
      setItems(
        targets.map((i) => ({ submissionId: created.id, playerId: i.playerId, origin: i.origin, outcome: 'pending' as const, recordId: i.recordId })),
      );
      return created;
    });
    launch(row);
    return { submissionId: row.id };
  }

  async function beginClear(leagueId: string, date: SessionDate, playSessionId: string, startedBy: string, connection: () => ActingConnection, retryOf: number | null) {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    assertUnlocked(leagueId);
    leagueGroup(deps.connections, leagueId);
    const as = connection();
    const candidate = await deps.resolver.find(leagueId, date, playSessionId, as.id);
    if (!candidate.editable) {
      throw new SubmissionError(
        'edit_window_closed',
        `play-tools stopped accepting attendance for this session on ${candidate.editableUntil?.toISOString()}.`,
      );
    }
    const groupId = leagueGroup(deps.connections, leagueId);
    const listed = await deps.gateway(as.id).listAttendance(groupId, candidate.id);
    if (!listed.some((r) => r.isPlayer)) throw new SubmissionError('nothing_to_clear', 'play-tools has no players in this session.');

    const row = db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: date,
          playSessionId: candidate.id,
          playSessionLabel: candidate.label,
          startedBy,
          ...professorOf(as),
          startedAt: now(),
          status: 'planned',
          retryOf,
          kind: 'clear',
        })
        .returning()
        .get();
      acquireLock(leagueId, created.id);
      return created;
    });
    launch(row);
    return { submissionId: row.id };
  }

  /** Starts a staff job for one of the date's tournaments, after the staffing module's checks (read fresh). */
  async function beginStaff(leagueId: string, date: SessionDate, tournamentId: string, actor: Actor, retryOf: number | null) {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    assertUnlocked(leagueId);
    const target = await deps.staffing.prepareApply(leagueId, date, tournamentId, actor);

    const row = db.transaction(() => {
      const created = insertStaffJob(leagueId, date, target, actor.username, retryOf);
      acquireLock(leagueId, created.id);
      return created;
    });
    launch(row);
    return { submissionId: row.id };
  }

  type StaffTarget = Awaited<ReturnType<StaffingService['prepareApply']>>;

  /** A `staff` job's row, planned. Call inside a transaction that takes or hands over the lease. */
  function insertStaffJob(leagueId: string, date: SessionDate, target: StaffTarget, startedBy: string, retryOf: number | null): Row {
    return db
      .insert(submission)
      .values({
        leagueId,
        sessionDate: date,
        playSessionId: target.tournamentId,
        playSessionLabel: `${STAFF_PREFIX}${target.label}`,
        startedBy,
        // A staff job runs as its tournament's organizer (#75), not the league's submitting professor.
        professorPlayerId: target.professor.playerId,
        professorName: target.professor.name,
        startedAt: now(),
        status: 'planned',
        retryOf,
        kind: 'staff',
        leaseId: target.leaseId,
      })
      .returning()
      .get();
  }

  // --- staff batches (#76) ---------------------------------------------------

  /** Who holds the lease between a batch's jobs: minus its id, never a submission's. */
  const batchHolder = (batchId: number) => -batchId;

  function setBatchItem(batchId: number, position: number, set: Partial<typeof staffBatchItem.$inferInsert>): void {
    db.update(staffBatchItem)
      .set(set)
      .where(and(eq(staffBatchItem.batchId, batchId), eq(staffBatchItem.position, position)))
      .run();
  }

  /** How a batch row reads a finished job's status; a job still active when its run ended failed. */
  const ROW_STATUS: Record<SubmissionStatus, StaffBatchRowStatus> = {
    planned: 'failed',
    running: 'failed',
    succeeded: 'succeeded',
    partial: 'partial',
    failed: 'failed',
    interrupted: 'interrupted',
  };

  /**
   * Runs a batch's tournaments one at a time. The lease passes from the batch to each job and back, never
   * freed in between. On shutdown it starts nothing more and leaves the batch for boot recovery.
   */
  async function runBatch(batch: typeof staffBatch.$inferSelect, items: readonly { position: number; tournamentId: string }[], actor: Actor) {
    const { leagueId, id: batchId } = batch;
    const date = batch.sessionDate as SessionDate;
    const holder = { leagueId, id: batchHolder(batchId) };
    const ended: StaffBatchRowStatus[] = [];
    for (const item of items) {
      if (stop.signal.aborted) return;
      renewLock(holder);
      let target: StaffTarget;
      try {
        target = await deps.staffing.prepareApply(leagueId, date, item.tournamentId, actor);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        setBatchItem(batchId, item.position, {
          status: 'not_started',
          refusalCode: typeof code === 'string' ? code : 'unexpected',
          refusalMessage: (err as Error).message,
        });
        ended.push('not_started');
        continue;
      }
      if (stop.signal.aborted) return;
      const row = db.transaction(() => {
        const created = insertStaffJob(leagueId, date, target, batch.startedBy, null);
        handOverLock(leagueId, holder.id, created.id);
        setBatchItem(batchId, item.position, { status: 'running', submissionId: created.id, tournamentLabel: target.label });
        return created;
      });
      await execute(row);
      handOverLock(leagueId, row.id, holder.id);
      const status = ROW_STATUS[load(leagueId, row.id)!.status];
      setBatchItem(batchId, item.position, { status });
      ended.push(status);
    }
    db.update(staffBatch).set({ status: batchStatus(ended), finishedAt: now() }).where(eq(staffBatch.id, batchId)).run();
    log.info(`Staff batch #${batchId} ${batchStatus(ended)}`, { batchId });
  }

  function launchBatch(batch: typeof staffBatch.$inferSelect, items: readonly { position: number; tournamentId: string }[], actor: Actor): void {
    log.info(`Staff batch #${batch.id} started for ${batch.sessionDate}`, { batchId: batch.id, date: batch.sessionDate });
    const job = runBatch(batch, items, actor)
      .catch((err: unknown) => {
        log.warn(`Staff batch #${batch.id} failed: ${(err as Error).message}`, { batchId: batch.id });
        db.update(staffBatch).set({ status: 'failed', finishedAt: now() }).where(eq(staffBatch.id, batch.id)).run();
      })
      .catch(() => {
        // The database is gone (shutdown); boot recovery marks the batch.
      })
      .finally(() => {
        try {
          releaseLock({ leagueId: batch.leagueId, id: batchHolder(batch.id) });
        } catch {
          // The database is gone (shutdown); the lease expires on its own.
        }
        running.delete(job);
      });
    running.add(job);
  }

  /** Staff batches need the league chosen in Settings; their tournaments are the league's. */
  function assertLeagueChosen(leagueId: string): void {
    leagueGroup(deps.connections, leagueId);
  }

  /**
   * Why a batch row whose organizer another user holds, and hasn't lent it to the caller, is refused before the batch
   * starts (ADR-0015 §4, §5); null when it may run.
   */
  function refusedAtStart(actor: Actor, organizerPlayerId: string | undefined, tournamentId: string): { code: string; message: string } | null {
    if (organizerPlayerId === undefined) return null; // nobody's listing had it: its turn reads it fresh
    try {
      deps.connections.actingConnection(actor, organizerPlayerId, { kind: 'tournament', tournamentId, use: 'staff' });
      return null;
    } catch (err) {
      if (!(err instanceof ConnectionAccessError) || err.code !== 'not_your_connection') return null; // its turn refuses it, as before
      const c = deps.connections.listActingConnections().find((x) => x.professorPlayerId === organizerPlayerId);
      return { code: 'not_your_connection', message: `Only ${c ? connectionName(c) : `Professor ${organizerPlayerId}`} can change this tournament's staff.` };
    }
  }

  async function beginStaffBatch(leagueId: string, date: SessionDate, tournamentIds: readonly string[], actor: Actor) {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    assertLeagueChosen(leagueId);
    assertUnlocked(leagueId);
    const organizers = await deps.staffing.organizersOn(leagueId, date);
    const all = tournamentIds.map((tournamentId, position) => ({ position, tournamentId, refusal: refusedAtStart(actor, organizers.get(tournamentId), tournamentId) }));
    if (all.every((i) => i.refusal)) {
      throw new StaffingError('not_your_connection', all[0]?.refusal?.message ?? 'None of these tournaments is yours to staff.', {
        professorPlayerId: organizers.get(all[0]?.tournamentId ?? '') ?? '',
      });
    }
    const items = all.filter((i) => !i.refusal).map(({ position, tournamentId }) => ({ position, tournamentId }));
    const batch = db.transaction(() => {
      assertUnlocked(leagueId);
      const created = db
        .insert(staffBatch)
        .values({ leagueId, sessionDate: date, startedBy: actor.username, startedAt: now(), status: 'running' })
        .returning()
        .get();
      for (const { refusal, ...item } of all) {
        db.insert(staffBatchItem)
          .values({
            batchId: created.id,
            ...item,
            tournamentLabel: item.tournamentId,
            ...(refusal && { status: 'not_started' as const, refusalCode: refusal.code, refusalMessage: refusal.message }),
          })
          .run();
      }
      acquireLock(leagueId, batchHolder(created.id));
      return created;
    });
    launchBatch(batch, items, actor);
    return { batchId: batch.id };
  }

  function batchView(batch: typeof staffBatch.$inferSelect): StaffBatchView {
    const items = db
      .select({ item: staffBatchItem, job: submission })
      .from(staffBatchItem)
      .leftJoin(submission, eq(submission.id, staffBatchItem.submissionId))
      .where(eq(staffBatchItem.batchId, batch.id))
      .orderBy(staffBatchItem.position)
      .all();
    return {
      id: batch.id,
      sessionDate: batch.sessionDate,
      status: batch.status,
      startedBy: batch.startedBy,
      startedAt: batch.startedAt,
      finishedAt: batch.finishedAt,
      rows: items.map(({ item, job }) => {
        const latest =
          job && item.status === 'running'
            ? db.select().from(submissionEvent).where(eq(submissionEvent.submissionId, job.id)).orderBy(desc(submissionEvent.id)).limit(1).get()
            : undefined;
        const finished = job && !ACTIVE.includes(job.status) && item.status !== 'running';
        const c = finished ? counts(job) : null;
        return {
          position: item.position,
          tournamentId: item.tournamentId,
          label: item.tournamentLabel,
          organizerName: job?.professorName ?? null,
          status: item.status,
          submissionId: item.submissionId,
          progress: latest ? { done: latest.done, total: latest.total } : null,
          counts: c ? { added: c.added, alreadyPresent: c.alreadyPresent, failed: c.failed, skipped: c.skipped } : null,
          refusal: item.refusalCode === null ? null : { code: item.refusalCode, message: item.refusalMessage ?? '' },
        };
      }),
    };
  }

  async function beginImport(kind: ImportKind, leagueId: string, startedBy: string, retryOf: number | null) {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    // Every connected professor in the league is read (#75, ADR-0015 §3): it needs one who can be, and the league chosen.
    const conns = deps.connections.listReadableConnections();
    if (conns.length === 0) throw new PokemonUpstreamError('not_connected', 'No Pokémon account is connected. Connect one in Settings.');
    if (conns.every((c) => c.status === 'needs_reconnect')) {
      throw new PokemonUpstreamError('needs_reconnect', 'Every connected Pokémon account needs a reconnect. Reconnect one in Settings.');
    }
    leagueGroup(deps.connections, leagueId);
    const row = db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: dateIn(now(), timeZone),
          playSessionId: '',
          playSessionLabel: IMPORT_LABEL[kind],
          startedBy,
          // Read as every connected professor, so no single one (#75).
          professorPlayerId: null,
          professorName: null,
          startedAt: now(),
          status: 'planned',
          retryOf,
          kind,
        })
        .returning()
        .get();
      acquireLock(leagueId, created.id);
      return created;
    });
    launch(row);
    return { submissionId: row.id };
  }

  // --- the service -----------------------------------------------------------

  const service: SubmissionService = {
    start: (leagueId, date, input) =>
      begin(leagueId, date, input.playSessionId, input.actor.username, () => submitter(input.actor, input.professorPlayerId), null),

    async retry(leagueId, submissionId, actor) {
      const row = mustFind(leagueId, submissionId);
      if (ACTIVE.includes(row.status)) {
        throw new SubmissionError('submission_running', 'This submission is still running. Wait for it to finish.');
      }
      if (row.kind === 'undo') return beginUndo(leagueId, mustFind(leagueId, row.undoOf!), actor, row.id);
      if (row.kind === 'clear') {
        return beginClear(leagueId, row.sessionDate as SessionDate, row.playSessionId, actor.username, () => originalConnection(actor, row), row.id);
      }
      if (row.kind === 'tdf_upload') {
        throw new TournamentsError('use_upload_again', 'A results upload is never sent again on its own. Use Upload again… to check the file and send it.');
      }
      if (isRemoval(row)) return retryStaffRemoval(row, actor);
      if (row.kind === 'staff') return beginStaff(leagueId, row.sessionDate as SessionDate, row.playSessionId, actor, row.id);
      if (isImport(row)) {
        // Imports are the owner's (ADR-0015 §4), and retry is a member route.
        if (actor.role !== 'owner') throw new SubmissionError('owner_only', 'Only the owner of this app can run an import.');
        return beginImport(row.kind, leagueId, actor.username, row.id);
      }
      if (row.kind === 'tournament_edit') return retryTournamentEdit(row, actor);
      if (row.kind === 'tournament_cancel') return retryTournamentCancel(row, actor);
      if (row.kind === 'tournament_create') {
        const items = tournamentItems(row.id);
        const plannedIds = creation().retryable(
          leagueId,
          items.flatMap((i) => (i.plannedTournamentId === null ? [] : [i.plannedTournamentId])),
        );
        if (plannedIds.length === 0) throw new TournamentsError('nothing_to_create', 'Every tournament of this job is in play-tools, unknown or skipped.');
        return beginTournamentCreate(
          leagueId,
          {
            plannedIds,
            acknowledgeShortNotice: true,
            retryUnknown: false,
            actor,
            label: row.playSessionLabel,
            ...(row.throughScheduleId !== null && row.throughDate !== null && { through: { scheduleId: row.throughScheduleId, date: row.throughDate } }),
            wasShortNotice: new Set(items.filter((i) => i.shortNotice).map((i) => i.plannedTournamentId!)),
          },
          row.id,
        );
      }
      return begin(leagueId, row.sessionDate as SessionDate, row.playSessionId, actor.username, () => originalConnection(actor, row), row.id);
    },

    async resolve(leagueId, date, actor) {
      leagueGroup(deps.connections, leagueId);
      return deps.resolver.resolve(leagueId, date, deps.connections.readingConnection(leagueId, actor));
    },

    undo: async (leagueId, submissionId, actor) => beginUndo(leagueId, mustFind(leagueId, submissionId), actor, null),

    async previewClear(leagueId, date, playSessionId, actor) {
      const groupId = leagueGroup(deps.connections, leagueId);
      const readAs = deps.connections.readingConnection(leagueId, actor);
      const candidate = await deps.resolver.find(leagueId, date, playSessionId, readAs);
      const listed = await deps.gateway(readAs).listAttendance(groupId, candidate.id);
      const ours = ourRecordIds({ leagueId, playSessionId: candidate.id });
      const players = new Map<PlayerId, { playerId: PlayerId; name: string; addedByApp: boolean }>();
      for (const r of listed.filter((x) => x.isPlayer)) {
        const seen = players.get(r.playerId);
        players.set(r.playerId, { playerId: r.playerId, name: seen?.name || r.name, addedByApp: (seen?.addedByApp ?? false) || ours.has(r.recordId) });
      }
      const known = new Map(deps.roster.getPlayers(leagueId, [...players.keys()]).map((p) => [p.playerId, p.displayName]));
      return {
        playSessionId: candidate.id,
        playSessionLabel: candidate.label,
        players: [...players.values()].map((p) => ({ ...p, name: known.get(p.playerId) || p.name })),
        staffKept: listed.filter((x) => !x.isPlayer).length,
        otherSessionHasAppRecords: heldElsewhere(leagueId, date, candidate.id, ['added']).length > 0,
      };
    },

    clear: async (leagueId, date, playSessionId, actor, professorPlayerId) =>
      beginClear(leagueId, date, playSessionId, actor.username, () => submitter(actor, professorPlayerId), null),

    applyStaff: async (leagueId, date, input) => beginStaff(leagueId, date, input.tournamentId, input.actor, null),

    importStaff: async (leagueId, actor) => beginImport('staff_import', leagueId, actor.username, null),

    importPlayers: async (leagueId, actor) => beginImport('player_import', leagueId, actor.username, null),

    applyStaffAll: async (leagueId, date, input) => beginStaffBatch(leagueId, date, input.tournamentIds, input.actor),

    createTournaments: async (leagueId, input) => beginTournamentCreate(leagueId, input, null),

    async createThrough(leagueId, input) {
      if (!deps.tournaments) throw new Error('This app was built without the tournaments module.');
      const preview = await deps.tournaments.createThrough(leagueId, input.scheduleId, input.date);
      if (preview.tooMany) {
        throw new TournamentsError('too_many_tournaments', `That is ${preview.count} tournaments; one job creates at most 60. Try a nearer date.`, {
          count: preview.count,
          suggestedThrough: preview.suggestedThrough,
        });
      }
      if (preview.count === 0) throw new TournamentsError('nothing_to_create', `Nothing to create through ${input.date}.`);
      return beginTournamentCreate(
        leagueId,
        {
          plannedIds: preview.tournaments.map((e) => e.plannedId!),
          acknowledgeShortNotice: input.acknowledgeShortNotice,
          retryUnknown: false,
          actor: input.actor,
          label: `Create ${preview.scaffoldName} through ${input.date}`,
          through: { scheduleId: input.scheduleId, date: input.date },
        },
        null,
      );
    },

    editTournaments: async (leagueId, input) => beginTournamentEdit(leagueId, input),

    cancelTournament: async (leagueId, input) => beginTournamentCancel(leagueId, input),

    uploadResults: async (leagueId, input) => beginTdfUpload(leagueId, input),

    async removeResultsStaff(leagueId, input) {
      if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
      assertUnlocked(leagueId);
      const plan = await results().checkRemovable(leagueId, input.date, input.tournamentId, input.uploadId, input.playerIds, input.actor);
      if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
      const row = insertRemovalJob(leagueId, { plan, startedBy: input.actor.username, retryOf: null });
      launch(row);
      return { submissionId: row.id };
    },

    async followResults(leagueId, submissionId) {
      const row = mustFind(leagueId, submissionId);
      if (row.kind !== 'tdf_upload' || row.resultsUploadId === null) return;
      const item = tournamentItems(row.id)[0];
      if (item?.outcome !== 'processing') return;
      const state = await results().follow(leagueId, row.resultsUploadId);
      if (state === 'complete') setTournamentItem(row.id, item.position, { outcome: 'uploaded', errorCode: null });
      if (state === 'failed') setTournamentItem(row.id, item.position, { outcome: 'processing_failed', errorCode: results().peek(row.resultsUploadId)?.errorCode ?? null });
    },

    staffBatch(leagueId, batchId) {
      assertLeagueChosen(leagueId);
      const batch = db
        .select()
        .from(staffBatch)
        .where(and(eq(staffBatch.id, batchId), eq(staffBatch.leagueId, leagueId)))
        .get();
      if (!batch) throw new SubmissionError('not_found', `Staff batch ${batchId} does not exist.`);
      return batchView(batch);
    },

    runningStaffBatch(leagueId, date) {
      assertLeagueChosen(leagueId);
      const batch = db
        .select()
        .from(staffBatch)
        .where(and(eq(staffBatch.leagueId, leagueId), eq(staffBatch.sessionDate, date), eq(staffBatch.status, 'running')))
        .orderBy(desc(staffBatch.id))
        .get();
      return batch ? batchView(batch) : null;
    },

    get(leagueId, submissionId) {
      const row = mustFind(leagueId, submissionId);
      const items = db.select().from(submissionItem).where(eq(submissionItem.submissionId, row.id)).all();
      const undone = row.kind === 'submit' ? removedBy(row.id) : new Map<string, number>();
      const names = new Map(
        deps.roster.getPlayers(leagueId, items.map((i) => i.playerId as PlayerId)).map((p) => [p.playerId, p.displayName]),
      );
      return {
        ...summary(row),
        playSessionId: row.playSessionId,
        error: row.error,
        items: items.map((i) => ({
          playerId: i.playerId as PlayerId,
          displayName: names.get(i.playerId as PlayerId) ?? '',
          origin: i.origin,
          outcome: i.outcome,
          error: i.error,
          recordId: i.recordId,
          asStaff: i.asStaff,
          removedBy: undone.get(i.playerId) ?? null,
          role: i.role,
          errorCode: i.errorCode,
          suggestedPlayerId: i.suggestedPlayerId as PlayerId | null,
        })),
        ...(row.kind === 'staff_import' ? { staffImport: staffImportResult(row, items, names) } : {}),
        ...(row.kind === 'player_import' ? { playerImport: playerImportResult(row, items, names) } : {}),
        tournamentItems: isTournamentJob(row) ? tournamentItems(row.id).map(tournamentItemView) : [],
      };
    },

    list(leagueId, filter = {}) {
      return db
        .select()
        .from(submission)
        .where(and(eq(submission.leagueId, leagueId), filter.date ? eq(submission.sessionDate, filter.date) : undefined))
        .orderBy(desc(submission.startedAt), desc(submission.id))
        .all()
        .map(summary);
    },

    timesSubmitted(leagueId) {
      const rows = db
        .select({ submissionId: submission.id, playerId: submissionItem.playerId, date: submission.sessionDate })
        .from(submissionItem)
        .innerJoin(submission, eq(submission.id, submissionItem.submissionId))
        .where(and(eq(submission.leagueId, leagueId), eq(submission.kind, 'submit'), inArray(submissionItem.outcome, ['added', 'already_present'])))
        .all();
      const undone = new Set(
        db
          .select({ undoOf: submission.undoOf, playerId: submissionItem.playerId })
          .from(submissionItem)
          .innerJoin(submission, eq(submission.id, submissionItem.submissionId))
          .where(and(eq(submission.leagueId, leagueId), eq(submission.kind, 'undo'), inArray(submissionItem.outcome, GONE)))
          .all()
          .map((u) => `${u.undoOf}:${u.playerId}`),
      );
      const dates = new Map<PlayerId, Set<string>>();
      for (const r of rows) {
        if (undone.has(`${r.submissionId}:${r.playerId}`)) continue;
        const seen = dates.get(r.playerId as PlayerId) ?? new Set();
        seen.add(r.date);
        dates.set(r.playerId as PlayerId, seen);
      }
      return new Map([...dates].map(([playerId, seen]) => [playerId, seen.size]));
    },

    events(leagueId, submissionId, afterId = 0) {
      mustFind(leagueId, submissionId);
      return db
        .select()
        .from(submissionEvent)
        .where(and(eq(submissionEvent.submissionId, submissionId), gt(submissionEvent.id, afterId)))
        .orderBy(submissionEvent.id)
        .all()
        .map((e) => ({ id: e.id, at: e.at, type: e.type as SubmissionEventType, message: e.message, done: e.done, total: e.total }));
    },

    subscribe(submissionId, listener) {
      const set = listeners.get(submissionId) ?? new Set();
      set.add(listener);
      listeners.set(submissionId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(submissionId);
      };
    },

    recoverInterrupted() {
      const stale = db.select().from(submission).where(inArray(submission.status, ACTIVE)).all();
      for (const row of stale) stopEarly(row, 'interrupted', new Interrupted().message);
      // A batch a crash or a restart left running: its unfinished tournaments are interrupted (#76).
      const batches = db.select({ id: staffBatch.id }).from(staffBatch).where(eq(staffBatch.status, 'running')).all();
      for (const b of batches) {
        db.update(staffBatchItem)
          .set({ status: 'interrupted' })
          .where(and(eq(staffBatchItem.batchId, b.id), inArray(staffBatchItem.status, ['waiting', 'running'])))
          .run();
        db.update(staffBatch).set({ status: 'interrupted', finishedAt: now() }).where(eq(staffBatch.id, b.id)).run();
      }
      db.delete(submissionLock).run();
      return stale.length;
    },

    async shutdown() {
      if (!stop.signal.aborted) stop.abort(new Interrupted());
      await service.idle();
    },

    async idle() {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
  return service;
}
