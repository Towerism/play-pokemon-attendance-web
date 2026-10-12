import type { PlayerId } from '../../../shared/types/ids';
import type { StaffRole, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';

/** A staffer the organizer wants on the tournament, with the record this app holds for them (created or adopted). */
export interface WantedStaffer {
  playerId: PlayerId;
  role: string;
  recordId: string | null;
}

/** What a staff job does about one wanted staffer, decided from a fresh read of the tournament. */
export type StafferDecision =
  | { kind: 'assign' }
  /** Listed as staff in the wanted role: nothing to send; the record becomes the assignment's. */
  | { kind: 'already_assigned'; recordId: string }
  /** Our own record holds another role: `PATCH` it. */
  | { kind: 'rechange'; recordId: string }
  /** Listed some other way: nothing is ever sent for them. */
  | { kind: 'already_listed'; how: string }
  | { kind: 'is_organizer' };

/**
 * Decides one wanted staffer against everyone the tournament lists (ADR-0007
 * decisions 8 and 9). The organizer is never staff; a player id listed in any
 * way is never assigned; only the record this app holds is ever re-roled.
 * Ids are compared exactly as text.
 */
export function classifyStaffer(
  wanted: WantedStaffer,
  participants: readonly TournamentParticipant[],
  organizerPlayerId: PlayerId,
  roles: readonly StaffRole[],
): StafferDecision {
  if (wanted.playerId === organizerPlayerId) return { kind: 'is_organizer' };
  const records = participants.filter((p) => p.playerId === wanted.playerId);
  if (records.length === 0) return { kind: 'assign' };
  if (records.some((r) => !r.isStaff)) return { kind: 'already_listed', how: 'Listed as a player' };

  const own = records.find((r) => wanted.recordId !== null && r.recordId === wanted.recordId);
  if (own) return own.role === wanted.role ? { kind: 'already_assigned', recordId: own.recordId } : { kind: 'rechange', recordId: own.recordId };
  const same = records.find((r) => r.role === wanted.role);
  if (same) return { kind: 'already_assigned', recordId: same.recordId };
  const role = records[0]!.role ?? '';
  return { kind: 'already_listed', how: `Listed as ${roles.find((r) => r.code === role)?.label ?? role}` };
}

const REASONS: Record<string, string> = {
  missing_certification: "Not certified for this role at this tournament's product",
  player_id_must_be_claimed: "Player ID isn't claimed",
  below_age: 'Below the minimum age',
  disciplined: 'Disciplined',
  no_user: 'No Pokémon account for this player ID',
  unknown_reference: 'Not a valid player ID',
};

/** Why play-tools refused a staffer, as History shows it: `<code>: <reason>`, or the raw code for one the app doesn't know. */
export function refusalMessage(code: string, suggestedPlayerId?: PlayerId): string {
  if (code === 'merged_player_id' && suggestedPlayerId) return `${code}: Merged into ${suggestedPlayerId}. Edit the assignment to use that ID`;
  const reason = REASONS[code];
  return reason ? `${code}: ${reason}` : code;
}
