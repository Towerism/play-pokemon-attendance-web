import type { staffBatch, staffBatchItem } from '../../db/schema';

/**
 * Assign staff for every tournament on a date (#76, ADR-0007 update): one ordinary `staff` job per
 * tournament, run one after another, each as its organizer, under one hold of the league's lease.
 */
export type StaffBatchStatus = (typeof staffBatch.$inferSelect)['status'];
export type StaffBatchRowStatus = (typeof staffBatchItem.$inferSelect)['status'];

export interface StaffBatchRowView {
  /** 0-based run order. */
  position: number;
  tournamentId: string;
  /** The tournament's label once its turn read it; its id until then. */
  label: string;
  organizerName: string | null;
  status: StaffBatchRowStatus;
  /** Its staff job, once started. */
  submissionId: number | null;
  /** The running tournament's progress. */
  progress: { done: number; total: number } | null;
  /** A finished job's counts. */
  counts: { added: number; alreadyPresent: number; failed: number; skipped: number } | null;
  /** Why a tournament wasn't started. */
  refusal: { code: string; message: string } | null;
}

export interface StaffBatchView {
  id: number;
  sessionDate: string;
  status: StaffBatchStatus;
  startedBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  rows: StaffBatchRowView[];
}

/** Most tournaments one batch takes. */
export const MAX_BATCH_TOURNAMENTS = 20;

/**
 * A finished batch's status: `succeeded` when every tournament's job did, `failed` when none got
 * anywhere (failed, interrupted or not started), `partial` otherwise.
 */
export function batchStatus(rows: readonly StaffBatchRowStatus[]): 'succeeded' | 'partial' | 'failed' {
  if (rows.length > 0 && rows.every((r) => r === 'succeeded')) return 'succeeded';
  return rows.some((r) => r === 'succeeded' || r === 'partial') ? 'partial' : 'failed';
}
