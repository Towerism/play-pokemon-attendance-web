import type {
  ClearPreview,
  SubmissionCounts,
  SubmissionItemView,
  SubmissionKind,
  SubmissionStatus,
  SubmissionSummary,
} from '../../server/modules/submission/service';

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

export function submissionStatus(status: SubmissionStatus, kind: SubmissionKind = 'submit'): { label: string; color: BadgeColor } {
  if (kind === 'staff' && status === 'running') return { label: 'Assigning…', color: 'info' };
  if (kind !== 'submit' && status === 'running') return { label: 'Removing…', color: 'info' };
  return STATUS[status];
}

/** "Undo of #7" for an undo, "Cleared session …" for a clear, "Staff for …" for a staff job; null for a submission. */
export function historyLabel(
  s: Pick<SubmissionSummary, 'kind' | 'undoOf' | 'playSessionLabel'> & Partial<Pick<SubmissionSummary, 'tournamentLabel'>>,
): string | null {
  if (s.kind === 'undo') return `Undo of #${s.undoOf}`;
  // The server labels a staff job "Staff for <tournament>" already.
  if (s.kind === 'staff') return s.tournamentLabel ? `Staff for ${s.tournamentLabel}` : s.playSessionLabel;
  if (s.kind === 'clear') return `Cleared session ${s.playSessionLabel}`;
  return null;
}

/** Who an undo would remove: added players with a known record that no undo removed yet. */
export function undoCandidates(items: readonly SubmissionItemView[]): { names: string[]; withoutRecord: number } {
  const added = items.filter((i) => i.outcome === 'added' && i.removedBy === null);
  return {
    names: added.filter((i) => i.recordId !== null).map((i) => i.displayName || i.playerId),
    withoutRecord: added.filter((i) => i.recordId === null).length,
  };
}

export function undoConfirmText(count: number): string {
  return (
    `Remove ${count} ${count === 1 ? 'player' : 'players'} from play-tools? ` +
    `They will be taken off this date's player list and their TDF and "present" marks for that date cleared. Regulars stay regulars.`
  );
}

/** Why the undo button isn't offered; null when it is. */
export function undoBlockedText(
  s: Pick<SubmissionSummary, 'kind' | 'undoBlockedReason'> & { items: readonly SubmissionItemView[] },
): string | null {
  if (s.kind === 'undo') return "An undo can't be undone.";
  if (s.kind === 'clear') return "A cleared session can't be undone.";
  if (s.kind === 'staff') return 'Staff are changed from This week, not undone.';
  if (s.undoBlockedReason === 'not_undoable') return 'Only a finished submission can be undone.';
  if (s.undoBlockedReason === 'nothing_to_undo') {
    return s.items.some((i) => i.removedBy !== null) ? 'Already undone' : 'Nothing to undo: this submission added nobody.';
  }
  return null;
}

/** Clear session runs only once the organizer has typed the date exactly. */
export function clearConfirmed(typed: string, date: string): boolean {
  return typed === date;
}

export function clearConfirmText(preview: Pick<ClearPreview, 'players' | 'staffKept' | 'otherSessionHasAppRecords'>): string {
  const count = preview.players.length;
  const parts = [`Delete ${count} ${count === 1 ? 'player' : 'players'} from this play session in play-tools, including anyone entered there directly.`];
  if (preview.staffKept > 0) parts.push(`${preview.staffKept} staff ${preview.staffKept === 1 ? 'record stays' : 'records stay'}.`);
  if (preview.otherSessionHasAppRecords) {
    parts.push("Another play session that day also has players from this app; this date's player list and TDF imports are reset for the whole date.");
  }
  return parts.join(' ');
}

/** Still planning or sending. */
export function isSubmissionActive(status: string): boolean {
  return status === 'planned' || status === 'running';
}

export function progressPercent(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.min(100, Math.floor((done / total) * 100));
}
