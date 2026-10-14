import { dateIn } from '../../../shared/time/local-time';
import type { TournamentDetails, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';

/** The states play-tools lets a professor cancel from (S8). */
const CANCELLABLE: ReadonlySet<string> = new Set(['sanctioned', 'approval-pending', 'sanctioning-error']);
/** Statuses past any change, the same set an edit locks on. */
const DEAD: ReadonlySet<string> = new Set(['cancelled', 'complete', 'deleted', 'invalidated']);

export type Cancellability = { cancellable: true; reason: null } | { cancellable: false; reason: 'already_cancelled' | 'tournament_locked' };

/**
 * Whether play-tools lets a professor cancel the tournament now (ADR-0010 decision 8, Update #94): in a cancellable
 * state, not finished, and within start + 90 days when the start is known. play-tools still has the last word.
 */
export function cancellability(read: Pick<TournamentDetails, 'applicationState' | 'status' | 'activityState' | 'editableUntil'>, now: Date): Cancellability {
  const state = read.applicationState ?? read.status;
  if (state === 'cancelled' || read.status === 'cancelled') return { cancellable: false, reason: 'already_cancelled' };
  const locked =
    !CANCELLABLE.has(state) || DEAD.has(read.status) || read.activityState === 'completed' || (read.editableUntil !== null && now >= read.editableUntil);
  return locked ? { cancellable: false, reason: 'tournament_locked' } : { cancellable: true, reason: null };
}

/** Who a tournament lists besides its organizer: players, and staff in any role. Counts only, never who. */
export function participantCounts(participants: readonly TournamentParticipant[]): { players: number; staff: number } {
  return {
    players: participants.filter((p) => !p.isStaff && p.role !== 'organizer').length,
    staff: participants.filter((p) => p.isStaff && p.role !== 'organizer').length,
  };
}

/**
 * When anyone is listed, the organizer types the display id (or, without one, the local date in the venue's zone) to
 * confirm. It is shown in the preview: typing it proves intent, it is not a secret.
 */
export function confirmationFor(
  read: Pick<TournamentDetails, 'displayId' | 'startsAt' | 'venue'>,
  counts: { players: number; staff: number },
  leagueZone: string,
): { required: boolean; with: string | null } {
  if (counts.players + counts.staff === 0) return { required: false, with: null };
  const date = read.startsAt ? dateIn(read.startsAt, read.venue?.timeZone ?? leagueZone) : null;
  return { required: true, with: read.displayId ?? date };
}
