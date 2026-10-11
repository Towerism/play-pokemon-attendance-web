import type { SubmissionCounts, SubmissionStatus } from '../../server/modules/submission/service';

/** e.g. "9 added · 18 already in play-tools · 1 failed". */
export function submissionSummary(counts: SubmissionCounts): string {
  const parts = [
    counts.added && `${counts.added} added`,
    counts.alreadyPresent && `${counts.alreadyPresent} already in play-tools`,
    counts.failed && `${counts.failed} failed`,
    counts.skipped && `${counts.skipped} not sent`,
    counts.unrequested && `${counts.unrequested} more in play-tools only`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nothing to send';
}

type BadgeColor = 'success' | 'warning' | 'error' | 'info';

const STATUS: Record<SubmissionStatus, { label: string; color: BadgeColor }> = {
  planned: { label: 'Starting…', color: 'info' },
  running: { label: 'Sending…', color: 'info' },
  succeeded: { label: 'Done', color: 'success' },
  partial: { label: 'Partly done', color: 'warning' },
  failed: { label: 'Failed', color: 'error' },
  interrupted: { label: 'Interrupted', color: 'warning' },
};

export function submissionStatus(status: SubmissionStatus): { label: string; color: BadgeColor } {
  return STATUS[status];
}

/** Still planning or sending. */
export function isSubmissionActive(status: string): boolean {
  return status === 'planned' || status === 'running';
}

export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.min(100, Math.floor((done / total) * 100));
}
