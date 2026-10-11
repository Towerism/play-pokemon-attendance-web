import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { submission, submissionEvent, submissionItem, submissionLock } from '../../db/schema';
import type { SightingsService } from '../metrics/sightings';
import type { PokemonConnectionService } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { BulkResult, PlayToolsGateway } from '../pokemon/ports/play-tools-gateway';
import type { RosterService } from '../roster/service';
import type { SessionStatus, SessionsService } from '../sessions/service';
import { SubmissionError } from './errors';
import { type DesiredPlayer, type Plan, planSubmission } from './plan';
import { type PlaySessionResolver, submissionTarget } from './resolve';

export type SubmissionStatus = (typeof submission.$inferSelect)['status'];
export type ItemOutcome = (typeof submissionItem.$inferSelect)['outcome'];
export type ItemOrigin = (typeof submissionItem.$inferSelect)['origin'];

export interface SubmissionItemView {
  playerId: PlayerId;
  displayName: string;
  origin: ItemOrigin;
  outcome: ItemOutcome;
  error: string | null;
  recordId: string | null;
  asStaff: boolean;
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
  counts: SubmissionCounts;
}

export interface SubmissionView extends SubmissionSummary {
  playSessionId: string;
  /** Why the job stopped early; null otherwise. */
  error: string | null;
  items: SubmissionItemView[];
}

export type SubmissionEventType = 'planned' | 'batch_sent' | 'batch_rejected' | 'retrying' | 'reconciled' | 'finished';

/** Progress, persisted before it is pushed. `done` of `total` players to add are dealt with. */
export interface SubmissionEvent {
  id: number;
  at: Date;
  type: SubmissionEventType;
  message: string;
  done: number;
  total: number;
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
  sessions: Pick<SessionsService, 'getSession' | 'recordSubmission'>;
  roster: Pick<RosterService, 'ensurePlayers' | 'getPlayers'>;
  sightings: Pick<SightingsService, 'record'>;
  connections: Pick<PokemonConnectionService, 'getStatus'>;
  gateway: (leagueId: string) => Pick<PlayToolsGateway, 'listAttendance' | 'addAttendanceBulk'>;
  resolver: PlaySessionResolver;
  now?: () => Date;
  /** Rejects with `signal.reason` when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** ≤ 50 (ADR-0004). */
  batchSize?: number;
  /** ≥ 15 s by default, the CLI's empirically safe spacing. */
  batchDelayMs?: number;
  log?: { warn(message: string): void };
}

type Row = typeof submission.$inferSelect;
type ItemInsert = typeof submissionItem.$inferInsert;

/** Retries of one batch after a 429/5xx, before its players are failed. */
const MAX_RETRIES = 2;
/** The lock's lease, renewed before every bulk call; a crashed process's lease frees itself. */
const LEASE_MS = 2 * 60_000;
const ACTIVE: SubmissionStatus[] = ['planned', 'running'];

const DRAFT_STATUS: Record<SubmissionStatus, SessionStatus> = {
  planned: 'submitting',
  running: 'submitting',
  succeeded: 'submitted',
  partial: 'partial',
  failed: 'failed',
  interrupted: 'failed',
};

class Interrupted extends Error {
  override name = 'Interrupted';
  constructor() {
    super('The app stopped while this submission was running. Resume it to finish.');
  }
}

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
  const batchSize = deps.batchSize ?? 50;
  const batchDelayMs = deps.batchDelayMs ?? 15_000;
  const log = deps.log ?? { warn: (message: string) => console.warn(message) };

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
          set: { outcome: item.outcome, error: item.error ?? null, recordId: item.recordId ?? null, asStaff: item.asStaff ?? false },
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
        log.warn(`[submission] a progress listener failed: ${(err as Error).message}`);
      }
    }
  }

  function setStatus(row: Row, status: SubmissionStatus, error: string | null = null): void {
    const finished = !ACTIVE.includes(status);
    db.update(submission)
      .set({ status, error, ...(finished ? { finishedAt: now() } : {}) })
      .where(eq(submission.id, row.id))
      .run();
    deps.sessions.recordSubmission(row.leagueId, row.sessionDate as SessionDate, {
      playSessionId: row.playSessionId,
      status: DRAFT_STATUS[status],
    });
  }

  function counts(submissionId: number): SubmissionCounts {
    const outcomes = db
      .select({ outcome: submissionItem.outcome })
      .from(submissionItem)
      .where(eq(submissionItem.submissionId, submissionId))
      .all();
    const count = (o: ItemOutcome) => outcomes.filter((i) => i.outcome === o).length;
    return {
      added: count('added'),
      alreadyPresent: count('already_present'),
      failed: count('failed'),
      skipped: count('skipped'),
      unrequested: count('unrequested'),
    };
  }

  function summary(row: Row): SubmissionSummary {
    return {
      id: row.id,
      date: row.sessionDate as SessionDate,
      playSessionLabel: row.playSessionLabel,
      startedBy: row.startedBy,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      status: row.status,
      retryOf: row.retryOf,
      counts: counts(row.id),
    };
  }

  /** Record ids this league's own submissions added to the play session. */
  function ourRecordIds(row: Row): Set<string> {
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
    const held = db.select().from(submissionLock).where(eq(submissionLock.leagueId, leagueId)).get();
    if (held && held.expiresAt > now()) {
      throw new SubmissionError('submission_running', 'A submission is already running for this league. Wait for it to finish.');
    }
    const lease = { submissionId, expiresAt: new Date(now().getTime() + LEASE_MS) };
    db.insert(submissionLock)
      .values({ leagueId, ...lease })
      .onConflictDoUpdate({ target: submissionLock.leagueId, set: lease })
      .run();
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
    let done = 0;
    let lastBulkAt: number | undefined;

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
          if (retries >= MAX_RETRIES) {
            for (const p of pending) errors.set(p, err.message);
            done += pending.length;
            return;
          }
          retries += 1;
          emit(row, 'retrying', `${err.message} Trying that batch again.`, done, total);
          await pace(err.details.retryAfterMs);
          // A 5xx may still have recorded the batch; never send anyone twice.
          const present = new Set((await listAttendance()).map((r) => r.playerId));
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
        for (const p of result.alreadyPresent) othersAdded.add(p);
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

  /** A job that stops early: whoever was not sent yet is skipped. */
  function stopEarly(row: Row, status: 'failed' | 'interrupted', error: string): void {
    db.update(submissionItem)
      .set({ outcome: 'skipped' })
      .where(and(eq(submissionItem.submissionId, row.id), eq(submissionItem.outcome, 'pending')))
      .run();
    setStatus(row, status, error);
    const c = counts(row.id);
    const total = c.added + c.failed + c.skipped;
    emit(row, 'finished', `Submission ${status}: ${error}`, c.added + c.failed, total);
  }

  function launch(row: Row): void {
    const job = run(row)
      .catch((err: unknown) => {
        const interrupted = err instanceof Interrupted;
        if (!interrupted) log.warn(`[submission] #${row.id} failed: ${(err as Error).message}`);
        stopEarly(row, interrupted ? 'interrupted' : 'failed', (err as Error).message);
      })
      .catch((err: unknown) => log.warn(`[submission] #${row.id} could not record how it ended: ${(err as Error).message}`))
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

  // --- the service -----------------------------------------------------------

  const service: SubmissionService = {
    start: (leagueId, date, input) => begin(leagueId, date, input.playSessionId, input.startedBy, null),

    async retry(leagueId, submissionId, startedBy) {
      const row = mustFind(leagueId, submissionId);
      if (ACTIVE.includes(row.status)) {
        throw new SubmissionError('submission_running', 'This submission is still running. Wait for it to finish.');
      }
      return begin(leagueId, row.sessionDate as SessionDate, row.playSessionId, startedBy, row.id);
    },

    get(leagueId, submissionId) {
      const row = mustFind(leagueId, submissionId);
      const items = db.select().from(submissionItem).where(eq(submissionItem.submissionId, row.id)).all();
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
        })),
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
