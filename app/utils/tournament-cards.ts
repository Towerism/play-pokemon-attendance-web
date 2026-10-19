import type { SessionStaff, TournamentStaffView } from '../../server/modules/staffing/service';
import type { Upcoming, UpcomingEntry } from '../../server/modules/tournaments/service';
import type { ResultsSection, ResultsUploadView, ResultsWarning, UploadState } from '../../server/modules/tournaments/results';
import type { SubmissionView } from '../../server/modules/submission/service';
import { rowActions } from './tournaments';

// This week's tournament cards (#99, ADR-0010 decision 10, ADR-0011 decision 1): each play-tools tournament the Staff
// read lists, with its status from the date's Upcoming read, and the planned rows not in play-tools yet. Pure, so it's
// unit-tested; the components only bind it.

/** A play-tools tournament and its Upcoming entry; null when Upcoming wasn't read or doesn't list it. */
export interface CardPair {
  tournament: TournamentStaffView;
  entry: UpcomingEntry | null;
}

/** Planned rows still to create, or being created: a skipped or cancelled row without a guid gets no card. */
const PLANNED_CARD: ReadonlySet<UpcomingEntry['state']> = new Set(['planned', 'failed', 'unknown', 'creating']);

export function tournamentCards(
  staff: Pick<SessionStaff, 'tournaments'>,
  upcoming: Pick<Upcoming, 'tournaments'> | null,
): { cards: CardPair[]; planned: UpcomingEntry[] } {
  const entries = upcoming?.tournaments ?? [];
  const byGuid = new Map(entries.filter((e) => e.tournamentId).map((e) => [e.tournamentId!.toLowerCase(), e]));
  return {
    cards: staff.tournaments.map((tournament) => ({ tournament, entry: byGuid.get(tournament.tournamentId.toLowerCase()) ?? null })),
    planned: entries.filter((e) => e.plannedId !== null && e.tournamentId === null && PLANNED_CARD.has(e.state)),
  };
}

/** **Edit…** in a card's menu: the entry's actions decide; without one, a listed tournament whose organizer can act. */
export function cardEditable({ tournament, entry }: CardPair, only: string | null = null): boolean {
  if (only) return false;
  if (entry) return rowActions(entry).actions.includes('edit');
  const o = tournament.organizer;
  return !tournament.missing && !tournament.unavailable && !!o && o.connected && !o.needsReconnect;
}

type BadgeColor = 'neutral' | 'info' | 'success' | 'warning' | 'error';

/** A card's Results section (ADR-0011 decision 1): play-tools' state, the latest upload, and what can be done next. */
export interface ResultsView {
  status: { text: string; settings: boolean; retry: boolean };
  /** The dropzone: play-tools takes an upload, and nothing is being sent. */
  drop: boolean;
  download: boolean;
  /** "Results are in play-tools. This app has no copy of the TDF." */
  noCopy: boolean;
  latest: { label: string; color: BadgeColor; lines: string[]; details: number | null } | null;
  /** **Upload again…** from the archived file (ADR-0011 decision 5). */
  again: boolean;
  /** **Review upload…**: an open preview, picked up again after the dialog closed or a reload. */
  review: boolean;
  fileDeleted: boolean;
}

const UPSTREAM_TEXT: Record<'awaiting_results' | 'processing' | 'complete' | 'upload_failed' | 'results_already_uploaded', string> = {
  awaiting_results: 'Awaiting results',
  processing: 'Processing in play-tools',
  complete: 'Complete',
  upload_failed: 'play-tools couldn’t process the last upload. Upload the file again.',
  results_already_uploaded: 'play-tools already holds players for this tournament.',
};

const NOT_ACCEPTED: Record<string, { text: string; settings: boolean }> = {
  not_sanctioned: { text: 'Results can be uploaded once it is sanctioned.', settings: false },
  window_closed: { text: 'The upload window has closed.', settings: false },
  organizer_not_connected: { text: 'Connect the organizer’s Pokémon account to upload results.', settings: true },
  needs_reconnect: { text: 'Reconnect the organizer to upload results.', settings: true },
};

const UPLOAD_STATE: Record<UploadState, { label: string; color: BadgeColor }> = {
  previewed: { label: 'Not sent yet', color: 'neutral' },
  sending: { label: 'Sending…', color: 'info' },
  not_accepted: { label: 'Not accepted', color: 'error' },
  warnings_changed: { label: 'Warnings changed', color: 'warning' },
  validate_unknown: { label: 'Outcome unknown', color: 'warning' },
  processing: { label: 'Processing', color: 'info' },
  complete: { label: 'Complete', color: 'success' },
  failed: { label: 'Failed', color: 'error' },
};

/**
 * Attempts that end without play-tools holding the results: sent again only through **Upload again…**, and only while
 * play-tools takes an upload (the dropzone's condition), so never once it holds the tournament's results (#161).
 */
const AGAIN: ReadonlySet<UploadState> = new Set(['not_accepted', 'warnings_changed', 'validate_unknown', 'failed']);
const IN_FLIGHT: ReadonlySet<UploadState> = new Set(['sending', 'processing']);
const HOLDS_RESULTS: ReadonlySet<string> = new Set(['complete', 'processing', 'results_already_uploaded']);

function statusOf(upstream: ResultsSection['upstream']): ResultsView['status'] {
  if ('error' in upstream) return { text: upstream.error, settings: false, retry: true };
  if (upstream.status === 'results_not_accepted') {
    const known = upstream.reason ? NOT_ACCEPTED[upstream.reason] : undefined;
    return { text: known?.text ?? 'play-tools won’t take an upload now.', settings: known?.settings ?? false, retry: false };
  }
  return { text: UPSTREAM_TEXT[upstream.status], settings: false, retry: false };
}

function latestLines(u: ResultsUploadView): string[] {
  switch (u.state) {
    case 'not_accepted':
      return [
        ...u.errors.map((e) => `${e.message} (${e.code})`),
        'play-tools did not accept this file. Pokémon support can access the file from this failed attempt.',
      ];
    case 'validate_unknown':
      return ['We couldn’t tell whether play-tools received this file. Pokémon support may have a copy. Check the tournament in play-tools before you upload again.'];
    case 'warnings_changed':
      return ['The warnings changed since they were shown. Nothing was sent.'];
    case 'failed':
      return u.errorCode ? [u.errorCode] : [];
    default:
      return [];
  }
}

export function resultsView(s: ResultsSection): ResultsView {
  const upstream = 'error' in s.upstream ? null : s.upstream.status;
  const latest = s.latest;
  const takes = upstream === 'awaiting_results' || upstream === 'upload_failed';
  return {
    status: statusOf(s.upstream),
    drop: takes && !(latest && IN_FLIGHT.has(latest.state)),
    download: s.tdfAvailable,
    noCopy: !s.tdfAvailable && upstream !== null && HOLDS_RESULTS.has(upstream),
    latest: latest ? { ...UPLOAD_STATE[latest.state], lines: latestLines(latest), details: latest.submissionId } : null,
    again: takes && !!latest && AGAIN.has(latest.state) && !latest.fileDeleted,
    review: latest?.state === 'previewed',
    fileDeleted: !!latest?.fileDeleted,
  };
}

/** The upload dialog's warning order (#99): what the app changes in the file first, players new to the app last. */
const WARNING_ORDER: Record<ResultsWarning['code'], number> = {
  tdf_organizer_replaced: 0,
  tdf_wrong_organizer: 1,
  tdf_tournament_id_filled: 2,
  tdf_wrong_tournament: 3,
  tdf_wrong_game: 4,
  tdf_staff_also_playing: 5,
  tdf_unknown_players: 6,
};

export function orderedWarnings(warnings: readonly ResultsWarning[]): ResultsWarning[] {
  // Array.prototype.sort is stable, so each code keeps its own order.
  return [...warnings].sort((a, b) => WARNING_ORDER[a.code] - WARNING_ORDER[b.code]);
}

/** The send button (ADR-0011 decisions 4 and 8): named for the one fix the app makes, else Upload anyway after any warning. */
export function uploadButtonLabel(warnings: readonly Pick<ResultsWarning, 'code'>[]): string {
  if (warnings.length === 0) return 'Upload results';
  if (warnings.length === 1 && warnings[0]!.code === 'tdf_organizer_replaced') return 'Replace organizer and upload';
  if (warnings.length === 1 && warnings[0]!.code === 'tdf_tournament_id_filled') return 'Fill in id and upload';
  return 'Upload anyway';
}

/** Item outcomes after which nothing reached play-tools' results, or nobody can tell: send again from the card. */
const AGAIN_OUTCOMES: ReadonlySet<string> = new Set(['not_accepted', 'warnings_changed', 'validate_unknown']);
/** Outcomes after which play-tools holds the upload. */
const SENT_OUTCOMES: ReadonlySet<string> = new Set(['processing', 'uploaded']);

/**
 * History's **Upload again on This week** (ADR-0011 decision 5): a `tdf_upload` that ended without play-tools taking the
 * file. History never retries one itself; the card's dialog is the only way to send again.
 */
export function uploadAgainOffered(v: Pick<SubmissionView, 'kind' | 'status' | 'tournamentItems'>): boolean {
  if (v.kind !== 'tdf_upload') return false;
  const outcomes = v.tournamentItems.map((i) => i.outcome as string);
  if (outcomes.some((o) => AGAIN_OUTCOMES.has(o))) return true;
  return (v.status === 'failed' || v.status === 'interrupted') && !outcomes.some((o) => SENT_OUTCOMES.has(o));
}

/** What a route attached to its refusal (`data.data`): its code and details. */
function refusalData(err: unknown): Record<string, unknown> | null {
  const data = (err as { data?: { data?: unknown } } | null)?.data?.data;
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
}

/**
 * A confirm refused as `warnings_not_acknowledged` (ADR-0011 decision 4): the warnings and fingerprint the server holds
 * now, for the dialog to show before the organizer confirms again. Null for any other error.
 */
export function staleWarnings(err: unknown): { warnings: ResultsWarning[]; fingerprint: string } | null {
  const data = refusalData(err);
  if (data?.code !== 'warnings_not_acknowledged' || !Array.isArray(data.warnings) || typeof data.fingerprint !== 'string') return null;
  return { warnings: data.warnings as ResultsWarning[], fingerprint: data.fingerprint };
}

const NOT_REMOVABLE: Record<string, string> = { not_in_file: 'not in this file', not_staff: 'no longer on staff', organizer: 'the organizer' };

/** Remove from staff refused as `not_removable` (#101): one line per player the server wouldn't remove, and why. */
export function notRemovableLines(err: unknown): string[] {
  const data = refusalData(err);
  if (data?.code !== 'not_removable' || !Array.isArray(data.failures)) return [];
  return (data.failures as { playerId: string; reason: string }[]).map((f) => `${f.playerId}: ${NOT_REMOVABLE[f.reason] ?? f.reason}`);
}
