import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import { type Logger, silentLogger } from '../../logging/types';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { submission, submissionEvent, submissionItem, submissionLock } from '../../db/schema';
import type { SightingsService } from '../metrics/sightings';
import type { PokemonConnectionService } from '../pokemon/connection';
import { type PokemonErrorCode, PokemonUpstreamError } from '../pokemon/ports/errors';
import type { BulkResult, PlayToolsGateway, Tournament, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import type { RosterService } from '../roster/service';
import type { SessionStatus, SessionsService } from '../sessions/service';
import type { StaffAssignmentRecord, StaffingService } from '../staffing/service';
import { SubmissionError } from './errors';
import { forgetAttendance } from './forget';
import { dateIn } from './local-time';
import { type DesiredPlayer, type Plan, planSubmission } from './plan';
import { type PlaySessionResolver, connectedLeague, submissionTarget } from './resolve';
import { type StafferDecision, classifyStaffer, refusalMessage } from './staff-plan';

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
  startedAt: Date;
  finishedAt: Date | null;
  status: SubmissionStatus;
  retryOf: number | null;
  /** `undo` removes the records the submission `undoOf` added; `clear` removes every player record in the play session. */
  kind: SubmissionKind;
  undoOf: number | null;
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
  | 'tournament_failed';

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
   * the league's lock, and starts the job in the background.
   * @throws SubmissionError, PokemonUpstreamError
   */
  start(leagueId: string, date: SessionDate, input: { playSessionId: string; startedBy: string }): Promise<{ submissionId: number }>;
  /**
   * Retry (after `partial`/`failed`) or resume (after `interrupted`): a new
   * attempt for the same play session that plans again from upstream.
   * @throws SubmissionError, PokemonUpstreamError
   */
  retry(leagueId: string, submissionId: number, startedBy: string): Promise<{ submissionId: number }>;
  /** @throws SubmissionError `not_found` */
  get(leagueId: string, submissionId: number): SubmissionView;
  /** Newest first. */
  list(leagueId: string, filter?: { date?: SessionDate }): SubmissionSummary[];
  /**
   * Removes the records submission `submissionId` added, as a new `undo`
   * attempt that runs in the background.
   * @throws SubmissionError, PokemonUpstreamError
   */
  undo(leagueId: string, submissionId: number, startedBy: string): Promise<{ submissionId: number }>;
  /** What `clear` would delete; changes nothing. @throws SubmissionError, PokemonUpstreamError */
  previewClear(leagueId: string, date: SessionDate, playSessionId: string): Promise<ClearPreview>;
  /**
   * Clear session (danger zone): deletes every player record in the play
   * session, never a staff record, as a new `clear` attempt in the background.
   * @throws SubmissionError, PokemonUpstreamError
   */
  clear(leagueId: string, date: SessionDate, playSessionId: string, startedBy: string): Promise<{ submissionId: number }>;
  /**
   * Applies one of the date's tournaments' staff assignments to play-tools
   * (ADR-0007), as a new `staff` job in the background.
   * @throws StaffingError, SubmissionError, PokemonUpstreamError
   */
  applyStaff(leagueId: string, date: SessionDate, input: { tournamentId: string; startedBy: string }): Promise<{ submissionId: number }>;
  /**
   * Import staff from play-tools (ADR-0007 decision 5): reads every tournament
   * the account organizes, in any league, into the staff list, as a new
   * read-only `staff_import` job in the background.
   * @throws SubmissionError, PokemonUpstreamError
   */
  importStaff(leagueId: string, startedBy: string): Promise<{ submissionId: number }>;
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
  sessions: Pick<SessionsService, 'getSession' | 'recordSubmission' | 'removePlayer' | 'resetAfterClear'>;
  roster: Pick<RosterService, 'ensurePlayers' | 'getPlayers'>;
  sightings: Pick<SightingsService, 'record' | 'retract'>;
  connections: Pick<PokemonConnectionService, 'getStatus'>;
  gateway: (leagueId: string) => Pick<PlayToolsGateway, 'listAttendance' | 'addAttendanceBulk' | 'removeAttendance'>;
  /** The tournament calls a staff job makes (ADR-0007). */
  staffGateway: (
    leagueId: string,
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
  staffing: Pick<StaffingService, 'prepareApply' | 'assignmentsFor' | 'recordApplied' | 'recordFailed' | 'forgetRemoved' | 'recordUpstreamStaff'>;
  resolver: PlaySessionResolver;
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
/** A staff import's `play_session_label`; it has no play session or tournament of its own. */
const STAFF_IMPORT_LABEL = 'Staff import';

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
  constructor(readonly code: 'tournament_locked' | 'forbidden' | 'unknown_tournament') {
    super(code);
  }
}

/** Upstream errors after which a staff job sends nothing more to the tournament. */
const STAFF_STOPS = new Set(['tournament_locked', 'forbidden']);
/** Upstream errors that stop any job: the connection itself is gone. */
const CONNECTION_LOST = new Set(['needs_reconnect', 'not_connected']);

class Interrupted extends Error {
  override name = 'Interrupted';
  constructor() {
    super('The app stopped while this submission was running. Resume it to finish.');
  }
}

/** How logs name a job. */
const what = (row: { kind: SubmissionKind }) =>
  ({ submit: 'Submission', undo: 'Undo', clear: 'Clear', staff: 'Staff job', staff_import: 'Staff import' })[row.kind];

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
  const timeZone = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const log = deps.log ?? silentLogger;

  const running = new Set<Promise<void>>();
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

  function summary(row: Row): SubmissionSummary {
    const blocked = row.kind !== 'submit' || ACTIVE.includes(row.status) ? 'not_undoable' : undoTargets(row).length === 0 ? 'nothing_to_undo' : null;
    return {
      id: row.id,
      date: row.sessionDate as SessionDate,
      playSessionLabel: row.playSessionLabel,
      startedBy: row.startedBy,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      status: row.status,
      retryOf: row.retryOf,
      kind: row.kind,
      undoOf: row.undoOf,
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

  function renewLock(row: Row, extraMs = 0): void {
    db.update(submissionLock)
      .set({ expiresAt: new Date(now().getTime() + LEASE_MS + extraMs) })
      .where(and(eq(submissionLock.leagueId, row.leagueId), eq(submissionLock.submissionId, row.id)))
      .run();
  }

  function releaseLock(row: Row): void {
    db.delete(submissionLock)
      .where(and(eq(submissionLock.leagueId, row.leagueId), eq(submissionLock.submissionId, row.id)))
      .run();
  }

  // --- the job ---------------------------------------------------------------

  async function run(row: Row): Promise<void> {
    const { leagueId } = row;
    const date = row.sessionDate as SessionDate;
    const groupId = submissionTarget(deps.connections, leagueId);
    const gateway = deps.gateway(leagueId);
    const listAttendance = () => gateway.listAttendance(groupId, row.playSessionId);
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
          result = await gateway.addAttendanceBulk(groupId, row.playSessionId, pending);
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
    const gateway = deps.gateway(row.leagueId);
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
          const result = await gateway.removeAttendance(groupId, row.playSessionId, recordId);
          return { outcome: result === 'removed' ? 'removed' : 'already_removed' };
        } catch (err) {
          if (!(err instanceof PokemonUpstreamError) || !err.retryable) throw err;
          if (retries >= MAX_RETRIES) return { outcome: 'failed', error: err.message };
          emit(row, 'retrying', `${err.message} Trying that record again.`, done, total);
          await pace(err.details.retryAfterMs);
          if (err.code === 'unavailable') {
            const listed = await gateway.listAttendance(groupId, row.playSessionId);
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
    const still = new Set((await deps.gateway(row.leagueId).listAttendance(groupId, row.playSessionId)).map((r) => r.recordId));
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
    const groupId = submissionTarget(deps.connections, row.leagueId);
    const gateway = deps.gateway(row.leagueId);
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
    const groupId = submissionTarget(deps.connections, row.leagueId);
    setStatus(row, 'running');

    const recordsOf = new Map<string, string[]>();
    const names = new Map<string, string>();
    for (const r of await deps.gateway(row.leagueId).listAttendance(groupId, row.playSessionId)) {
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
    const gateway = deps.staffGateway(leagueId);
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
    let lastWriteAt: number | undefined;
    /** Keeps writes at least `staffDelayMs` apart, or longer when play-tools asks; stops on shutdown. */
    async function pace(atLeastMs = 0): Promise<void> {
      if (stop.signal.aborted) throw stop.signal.reason;
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
          lastWriteAt = now().getTime();
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
          lastWriteAt = now().getTime();
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
          lastWriteAt = now().getTime();
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
   * Staff import (ADR-0007 decision 5): reads every tournament the account
   * organizes, in any league, and seeds the staff list from each one's
   * participants. Read-only, one call at a time and unpaced (organizer,
   * 2026-10-12: reads don't need pacing).
   */
  async function runStaffImport(row: Row): Promise<void> {
    const { leagueId } = row;
    const gateway = deps.staffGateway(leagueId);
    setStatus(row, 'running');
    let total = 0;
    let done = 0;

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

    // play-tools still lists tournaments from leagues the account has left, but refuses their records (#67).
    const leagues = new Set((await read(() => gateway.listLeagues(), 'the leagues')).map((l) => l.id));
    const listed = await read(() => gateway.listTournaments(), 'the tournaments');
    const tournaments = listed.filter((t) => t.groupId === null || leagues.has(t.groupId));
    const leftOut = listed.length - tournaments.length;
    total = tournaments.length;
    const why = leftOut ? `; ${leftOut} left out (leagues this account is no longer in)` : '';
    emit(row, 'planned', `${total} tournaments to read${why}.`, 0, total);
    /** Every staffer found so far: once new to the league, a staffer stays `new_player` for the whole import. */
    const found = new Map<PlayerId, 'found' | 'new_player'>();
    let failed = 0;
    let lastFailure: string | null = null;
    for (const t of tournaments) {
      let participants: TournamentParticipant[];
      try {
        participants = await read(() => gateway.listTournamentParticipants(t.id), 'that tournament');
      } catch (err) {
        // Gone, unreadable, or still down after 3 tries: this tournament only. Anything else stops the import.
        if (!(err instanceof PokemonUpstreamError) || !(err.retryable || SKIPPED_TOURNAMENT.includes(err.code))) throw err;
        failed += 1;
        lastFailure = err.code;
        log.warn(`Staff import #${row.id} could not read tournament ${t.id}: ${err.code}`, { submissionId: row.id, tournamentId: t.id, code: err.code });
        emit(row, 'tournament_failed', `Could not read a tournament (${err.code}).`, done + failed, total);
        continue;
      }
      db.transaction(() => seedFrom(row, t, participants, found));
      done += 1;
      emit(row, 'tournament_read', `Read ${done} of ${total} tournaments.`, done + failed, total);
    }
    const status = failed === 0 ? 'succeeded' : done > 0 ? 'partial' : 'failed';
    setStatus(row, status, status === 'failed' ? lastFailure : null);
    emit(row, 'finished', `Staff import ${status}: read ${done} of ${total} tournaments, found ${found.size} staff.`, done + failed, total);
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

  /** A staff import's tournaments: planned, read and given up on, from its events. */
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

  /** A job that stops early: whoever was not sent yet is skipped. */
  function stopEarly(row: Row, status: 'failed' | 'interrupted', error: string): void {
    db.update(submissionItem)
      .set({ outcome: 'skipped' })
      .where(and(eq(submissionItem.submissionId, row.id), eq(submissionItem.outcome, 'pending')))
      .run();
    if (row.kind === 'undo' || row.kind === 'clear') finishRemoval(row);
    if (row.kind === 'staff') finishStaff(row);
    setStatus(row, status, error);
    if (row.kind === 'staff_import') {
      const r = importProgress(row);
      emit(row, 'finished', `Staff import ${status}: ${error}`, r.tournamentsRead + r.tournamentsFailed, r.tournamentsTotal);
      return;
    }
    const c = counts(row);
    const total = c.added + c.failed + c.skipped;
    emit(row, 'finished', `Submission ${status}: ${error}`, c.added + c.failed, total);
  }

  function launch(row: Row): void {
    const submissionId = row.id;
    log.info(`${what(row)} #${submissionId} started for ${row.sessionDate}`, { submissionId, date: row.sessionDate });
    const job = (
      row.kind === 'undo'
        ? runUndo(row)
        : row.kind === 'clear'
          ? runClear(row)
          : row.kind === 'staff'
            ? runStaff(row)
            : row.kind === 'staff_import'
              ? runStaffImport(row)
              : run(row)
    )
      .catch((err: unknown) => {
        const interrupted = err instanceof Interrupted;
        if (!interrupted) log.warn(`${what(row)} #${submissionId} failed: ${(err as Error).message}`, { submissionId });
        // History shows a staff import's upstream stop as its code (forbidden, needs_reconnect, unavailable…).
        const reason = row.kind === 'staff_import' && err instanceof PokemonUpstreamError ? err.code : (err as Error).message;
        stopEarly(row, interrupted ? 'interrupted' : 'failed', reason);
      })
      .then(() => {
        const status = load(row.leagueId, submissionId)?.status;
        log.info(`${what(row)} #${submissionId} ${status}`, { submissionId, status });
      })
      .catch((err: unknown) => log.warn(`${what(row)} #${submissionId} could not record how it ended: ${(err as Error).message}`, { submissionId }))
      .finally(() => {
        try {
          releaseLock(row);
        } catch {
          // The database is gone (shutdown); the lease expires on its own.
        }
        running.delete(job);
      });
    running.add(job);
  }

  async function begin(leagueId: string, date: SessionDate, playSessionId: string, startedBy: string, retryOf: number | null) {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    const candidate = await deps.resolver.find(leagueId, date, playSessionId);
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

  async function beginUndo(leagueId: string, target: Row, startedBy: string, retryOf: number | null): Promise<{ submissionId: number }> {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    if (target.kind !== 'submit' || ACTIVE.includes(target.status)) {
      throw new SubmissionError('not_undoable', 'Only a finished submission can be undone.');
    }
    const targets = undoTargets(target);
    if (targets.length === 0) throw new SubmissionError('nothing_to_undo', 'This submission added nobody that is still to remove.');
    const date = target.sessionDate as SessionDate;
    const candidate = await deps.resolver.find(leagueId, date, target.playSessionId);
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
          startedBy,
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

  async function beginClear(leagueId: string, date: SessionDate, playSessionId: string, startedBy: string, retryOf: number | null) {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    assertUnlocked(leagueId);
    const candidate = await deps.resolver.find(leagueId, date, playSessionId);
    if (!candidate.editable) {
      throw new SubmissionError(
        'edit_window_closed',
        `play-tools stopped accepting attendance for this session on ${candidate.editableUntil?.toISOString()}.`,
      );
    }
    const groupId = submissionTarget(deps.connections, leagueId);
    const listed = await deps.gateway(leagueId).listAttendance(groupId, candidate.id);
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
  async function beginStaff(leagueId: string, date: SessionDate, tournamentId: string, startedBy: string, retryOf: number | null) {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    assertUnlocked(leagueId);
    const target = await deps.staffing.prepareApply(leagueId, date, tournamentId);

    const row = db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: date,
          playSessionId: target.tournamentId,
          playSessionLabel: `${STAFF_PREFIX}${target.label}`,
          startedBy,
          startedAt: now(),
          status: 'planned',
          retryOf,
          kind: 'staff',
        })
        .returning()
        .get();
      acquireLock(leagueId, created.id);
      return created;
    });
    launch(row);
    return { submissionId: row.id };
  }

  async function beginStaffImport(leagueId: string, startedBy: string, retryOf: number | null) {
    if (stop.signal.aborted) throw new SubmissionError('shutting_down', 'The app is restarting. Try again in a moment.');
    connectedLeague(deps.connections, leagueId);
    const row = db.transaction(() => {
      const created = db
        .insert(submission)
        .values({
          leagueId,
          sessionDate: dateIn(now(), timeZone),
          playSessionId: '',
          playSessionLabel: STAFF_IMPORT_LABEL,
          startedBy,
          startedAt: now(),
          status: 'planned',
          retryOf,
          kind: 'staff_import',
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
    start: (leagueId, date, input) => begin(leagueId, date, input.playSessionId, input.startedBy, null),

    async retry(leagueId, submissionId, startedBy) {
      const row = mustFind(leagueId, submissionId);
      if (ACTIVE.includes(row.status)) {
        throw new SubmissionError('submission_running', 'This submission is still running. Wait for it to finish.');
      }
      if (row.kind === 'undo') return beginUndo(leagueId, mustFind(leagueId, row.undoOf!), startedBy, row.id);
      if (row.kind === 'clear') return beginClear(leagueId, row.sessionDate as SessionDate, row.playSessionId, startedBy, row.id);
      if (row.kind === 'staff') return beginStaff(leagueId, row.sessionDate as SessionDate, row.playSessionId, startedBy, row.id);
      if (row.kind === 'staff_import') return beginStaffImport(leagueId, startedBy, row.id);
      return begin(leagueId, row.sessionDate as SessionDate, row.playSessionId, startedBy, row.id);
    },

    undo: async (leagueId, submissionId, startedBy) => beginUndo(leagueId, mustFind(leagueId, submissionId), startedBy, null),

    async previewClear(leagueId, date, playSessionId) {
      const candidate = await deps.resolver.find(leagueId, date, playSessionId);
      const groupId = submissionTarget(deps.connections, leagueId);
      const listed = await deps.gateway(leagueId).listAttendance(groupId, candidate.id);
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

    clear: async (leagueId, date, playSessionId, startedBy) => beginClear(leagueId, date, playSessionId, startedBy, null),

    applyStaff: async (leagueId, date, input) => beginStaff(leagueId, date, input.tournamentId, input.startedBy, null),

    importStaff: async (leagueId, startedBy) => beginStaffImport(leagueId, startedBy, null),

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
