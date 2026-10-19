import type { ConnectionView } from '../../server/modules/pokemon/connection';
import type {
  ClearPreview,
  PlayerImportResult,
  StaffImportResult,
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

/** What a running tournament job is doing (#98). */
const RUNNING_TOURNAMENT = {
  tournament_create: 'Creating…',
  tournament_edit: 'Editing…',
  tournament_cancel: 'Cancelling…',
  tdf_upload: 'Uploading…',
} as const satisfies Partial<Record<SubmissionKind, string>>;

/** A job whose items are tournaments (`tournamentItems`), not players: History lists them with support details (#98). */
export function isTournamentJob(kind: SubmissionKind): boolean {
  return kind in RUNNING_TOURNAMENT;
}

export function submissionStatus(status: SubmissionStatus, kind: SubmissionKind = 'submit'): { label: string; color: BadgeColor } {
  if ((kind === 'staff_import' || kind === 'player_import') && status === 'running') return { label: 'Reading…', color: 'info' };
  if (kind === 'staff' && status === 'running') return { label: 'Assigning…', color: 'info' };
  if (status === 'running' && kind in RUNNING_TOURNAMENT) return { label: RUNNING_TOURNAMENT[kind as keyof typeof RUNNING_TOURNAMENT], color: 'info' };
  if (kind !== 'submit' && status === 'running') return { label: 'Removing…', color: 'info' };
  return STATUS[status];
}

/** "Undo of #7" for an undo, "Cleared session …" for a clear, "Staff for …" for a staff job, "Staff import" or "Player import" for one; null for a submission. */
export function historyLabel(
  s: Pick<SubmissionSummary, 'kind' | 'undoOf' | 'playSessionLabel'> & Partial<Pick<SubmissionSummary, 'tournamentLabel'>>,
): string | null {
  if (s.kind === 'undo') return `Undo of #${s.undoOf}`;
  // The server labels a staff job "Staff for <tournament>" already.
  if (s.kind === 'staff') return s.tournamentLabel ? `Staff for ${s.tournamentLabel}` : s.playSessionLabel;
  if (s.kind === 'clear') return `Cleared session ${s.playSessionLabel}`;
  if (s.kind === 'staff_import') return 'Staff import';
  if (s.kind === 'player_import') return 'Player import';
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
  if (s.kind === 'staff_import') return "A staff import can't be undone.";
  if (s.kind === 'player_import') return "A player import can't be undone.";
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

/** e.g. "Read 115 of 117 tournaments · 2 could not be read · 42 staff found · 3 new players". */
export function staffImportSummary(r: StaffImportResult): string {
  if (r.tournamentsTotal === 0) return 'No tournaments to read';
  const added = r.newPlayers.length;
  return [
    `Read ${r.tournamentsRead} of ${r.tournamentsTotal} tournaments`,
    r.tournamentsFailed && `${r.tournamentsFailed} could not be read`,
    `${r.staffersFound} staff found`,
    added && `${added} new ${added === 1 ? 'player' : 'players'}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** e.g. "Read 115 of 117 tournaments · 2 could not be read · 640 players found · 37 new players". */
export function playerImportSummary(r: PlayerImportResult): string {
  const notRead = r.sessionsError && `Play sessions not read: ${SESSIONS_ERRORS[r.sessionsError] ?? r.sessionsError}`;
  if (r.tournamentsTotal === 0 && r.sessionsTotal === 0) return ['No tournaments or play sessions to read', notRead].filter(Boolean).join(' · ');
  const tournaments = r.tournamentsTotal > 0 && `${r.tournamentsRead} of ${r.tournamentsTotal} tournaments`;
  const sessions = r.sessionsTotal > 0 && `${r.sessionsRead} of ${r.sessionsTotal} play sessions`;
  const failed = r.tournamentsFailed + r.sessionsFailed;
  const added = r.newPlayers.length;
  return [
    `Read ${[tournaments, sessions].filter(Boolean).join(' and ')}`,
    failed && `${failed} could not be read`,
    `${r.playersFound} ${r.playersFound === 1 ? 'player' : 'players'} found`,
    added && `${added} new ${added === 1 ? 'player' : 'players'}`,
    notRead,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Why a player import read none of the league's play sessions (#195), by the code on its `sessions_failed` event. */
const SESSIONS_ERRORS: Record<string, string> = {
  login_rejected: "play-tools rejected the submitting professor's login. Reconnect them in Settings",
  forbidden: "play-tools refused to show this league's play sessions",
  needs_reconnect: 'the submitting professor needs reconnecting',
  not_connected: "the league's Pokémon account isn't connected",
  unavailable: 'play-tools could not be reached',
  rate_limited: 'play-tools could not be reached',
};

/** Why Import staff (or players) from play-tools can't start; null when it can. */
export function staffImportBlocked(c: Pick<ConnectionView, 'status' | 'league'> | null | undefined): string | null {
  if (!c || c.status === 'not_connected') return 'Connect a Pokémon account first.';
  if (c.status === 'needs_reconnect') return 'Reconnect the Pokémon account first.';
  if (!c.league) return 'Choose the league first.';
  return null;
}

const STAFF_IMPORT_ERRORS: Record<string, string> = {
  forbidden: 'play-tools refused to show these tournaments. Check which Pokémon account is connected.',
  needs_reconnect: 'The Pokémon account needs reconnecting. Reconnect it above, then retry.',
  unavailable: 'play-tools could not be reached. Try again later.',
  rate_limited: 'play-tools asked to slow down. Try again later.',
  not_found: 'No tournament could be read.',
  unexpected_shape: 'No tournament could be read.',
};

/** Why a staff import stopped: its upstream code in words; any other message as it is. */
export function staffImportErrorText(error: string): string {
  return STAFF_IMPORT_ERRORS[error] ?? error;
}

/** Why a player import read nothing: it reads play sessions too (#195), so the words never blame tournaments alone. */
const PLAYER_IMPORT_ERRORS: Record<string, string> = {
  not_found: 'Nothing could be read.',
  unexpected_shape: 'Nothing could be read.',
  forbidden: 'play-tools refused the request. Check which Pokémon account is connected.',
  login_rejected: "play-tools rejected the submitting professor's login. Reconnect them in Settings, then retry.",
};

/** Why a player import stopped: its own words where the staff import's would mislead, else the staff import's. */
export function playerImportErrorText(error: string): string {
  return PLAYER_IMPORT_ERRORS[error] ?? staffImportErrorText(error);
}
