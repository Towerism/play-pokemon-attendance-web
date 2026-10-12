import type { OrganizerView, UnreadProfessor } from '../../server/modules/staffing/service';
import type { ItemOutcome } from '../../server/modules/submission/service';
import { professorLabel } from './pokemon-connections';

/** A staff role as `GET /staff/roles` lists it. */
export interface StaffRole {
  code: string;
  label: string;
}

/** The role's play-tools label; the raw code for one the app doesn't offer, or while the roles aren't loaded. */
export function roleLabel(code: string, roles: readonly StaffRole[] | undefined): string {
  return roles?.find((r) => r.code === code)?.label ?? code;
}

/** When they last staffed; a dash when none of their tournaments has a date. */
export function lastStaffedLabel(date: string | null): string {
  return date ?? '—';
}

/** What saving an inline rename does: nothing for an empty or unchanged name, else send it as typed (the server trims). */
export type RenameDecision = { kind: 'blocked' } | { kind: 'unchanged' } | { kind: 'send'; name: string };

export function renameDecision(draft: string, currentName: string): RenameDecision {
  const trimmed = draft.trim();
  if (!trimmed) return { kind: 'blocked' };
  if (trimmed === currentName) return { kind: 'unchanged' };
  return { kind: 'send', name: draft };
}

/**
 * How a search result stands on one tournament's card: only `addable` can be
 * picked. The app never offers the organizer, anyone play-tools already lists,
 * or someone already staffing here (ADR-0007 decisions 8 and 9).
 */
export type StaffResultStatus = 'addable' | 'organizer' | 'staffing' | 'upstreamStaff' | 'playing';

export interface StaffResult {
  playerId: string;
  name: string;
  /** The role they last staffed in; null for someone who never staffed. */
  lastRole: string | null;
  status: StaffResultStatus;
  /** The role they hold on this card (`staffing`, `upstreamStaff`), for the tag. */
  role: string | null;
}

export interface StaffCard {
  organizer: { playerId: string } | null;
  players: readonly { playerId: string }[];
  assignments: readonly { playerId: string; role: string; state: string }[];
  upstreamOnly: readonly { playerId: string; role: string }[];
}

/** Staff-list matches first, then known players not on it; each person once, tagged against the card. */
export function toStaffResults(
  staff: readonly { playerId: string; name: string; lastRole: string }[],
  players: readonly { playerId: string; displayName: string }[],
  card: StaffCard,
): StaffResult[] {
  const found = new Map<string, { name: string; lastRole: string | null }>();
  for (const s of staff) if (!found.has(s.playerId)) found.set(s.playerId, { name: s.name, lastRole: s.lastRole });
  for (const p of players) if (!found.has(p.playerId)) found.set(p.playerId, { name: p.displayName, lastRole: null });

  return [...found].map(([playerId, { name, lastRole }]) => ({ playerId, name, lastRole, ...standing(playerId, card) }));
}

function standing(playerId: string, card: StaffCard): Pick<StaffResult, 'status' | 'role'> {
  if (card.organizer?.playerId === playerId) return { status: 'organizer', role: null };
  const mine = card.assignments.find((a) => a.playerId === playerId && a.state !== 'removing');
  if (mine) return { status: 'staffing', role: mine.role };
  const upstream = card.upstreamOnly.find((u) => u.playerId === playerId);
  if (upstream) return { status: 'upstreamStaff', role: upstream.role };
  if (card.players.some((p) => p.playerId === playerId)) return { status: 'playing', role: null };
  return { status: 'addable', role: null };
}

/** The role a pick starts with: their last role when play-tools still offers it, else the first (Judge). */
export function defaultRole(lastRole: string | null, roles: readonly StaffRole[] | undefined): string {
  if (lastRole && roles?.some((r) => r.code === lastRole)) return lastRole;
  return roles?.[0]?.code ?? 'judge';
}

/** How a result that can't be picked is listed on the card; none for one that can. */
export function staffTag(result: Pick<StaffResult, 'status' | 'role'>, roles: readonly StaffRole[] | undefined): string | undefined {
  switch (result.status) {
    case 'organizer':
      return 'Organizer';
    case 'staffing':
      return `Staffing as ${roleLabel(result.role ?? '', roles)}`;
    case 'upstreamStaff':
      return `${roleLabel(result.role ?? '', roles)} in play-tools`;
    case 'playing':
      return 'Playing';
    default:
      return undefined;
  }
}

/** What a staff job did for one staffer (ADR-0007 decision 4). */
export type StaffOutcome = Extract<
  ItemOutcome,
  | 'pending'
  | 'assigned'
  | 'already_assigned'
  | 'already_listed'
  | 'is_organizer'
  | 'role_changed'
  | 'ineligible'
  | 'removed'
  | 'already_removed'
  | 'failed'
  | 'skipped'
>;

// In summary order: what was sent, then the problems, then what needed nothing.
const SUMMARY: Record<StaffOutcome, string> = {
  assigned: 'assigned',
  role_changed: 'role changed',
  removed: 'removed',
  ineligible: 'not eligible',
  failed: 'failed',
  skipped: 'not sent',
  already_assigned: 'already in play-tools',
  already_listed: 'already listed',
  is_organizer: 'organizer',
  already_removed: 'already gone',
  pending: 'waiting',
};

/** e.g. "2 assigned · 1 not eligible · 1 already in play-tools". */
export function staffSummary(items: readonly { outcome: StaffOutcome }[]): string {
  const parts = (Object.keys(SUMMARY) as StaffOutcome[]).flatMap((outcome) => {
    const count = items.filter((i) => i.outcome === outcome).length;
    return count ? [`${count} ${SUMMARY[outcome]}`] : [];
  });
  return parts.length ? parts.join(' · ') : 'Nothing to send';
}

const ATTENTION: Partial<Record<StaffOutcome, string>> = {
  already_listed: 'already listed in play-tools',
  is_organizer: 'organizes this tournament',
  ineligible: 'not eligible',
  failed: 'failed',
  skipped: 'not sent',
};

/** A staffer the organizer should look at after a run: nothing sent for them, or play-tools refused them. */
export function needsAttention(item: { outcome: StaffOutcome }): boolean {
  return item.outcome in ATTENTION;
}

/**
 * Why, for one staffer. A refusal is shown as the server words it
 * (`<code>: <reason>`), including a `merged_player_id` suggestion, which is
 * never applied for the organizer.
 */
export function staffOutcomeText(item: { outcome: StaffOutcome; error: string | null }): string {
  if ((item.outcome === 'ineligible' || item.outcome === 'failed') && item.error) return item.error;
  return ATTENTION[item.outcome] ?? SUMMARY[item.outcome];
}

/** Our wording for an apply that couldn't start; undefined leaves it to the server's message. */
export function applyStartText(code: string | undefined): string | undefined {
  if (code === 'nothing_to_apply') return 'Nothing to send: play-tools already matches this list.';
  if (code === 'submission_running') return 'Another job is running for this league. Try again when it finishes.';
  return undefined;
}

/** A 409 `already_listed` on add: play-tools lists them on the tournament already (as `how`). */
export function alreadyListedText(who: { name: string; playerId: string }, how: 'player' | 'staff' | undefined): string {
  const as = how === 'player' ? ' as a player' : how === 'staff' ? ' as staff' : '';
  return `${who.name || who.playerId} is already listed in play-tools${as}.`;
}

/** A 200 on add: they were already wanted here in that role. */
export function alreadyStaffingText(who: { name: string; playerId: string; role: string }, roles: readonly StaffRole[] | undefined): string {
  return `${who.name || who.playerId} is already staffing as ${roleLabel(who.role, roles)}.`;
}

/** "Brock Harrison" with a display name, else "Professor <player id>". */
const organizerName = (o: Pick<OrganizerView, 'playerId' | 'name'>) => o.name ?? `Professor ${o.playerId}`;

/** The card's organizer line (#75): only they may log its staff. */
export function organizerText(organizer: OrganizerView | null): string | null {
  return organizer ? `Organized by ${organizerName(organizer)}` : null;
}

/** Why a card offers no staff actions, if it doesn't; `settings` when connecting a professor would fix it. */
export function readOnlyNote(card: {
  editable: boolean;
  missing?: true;
  unavailable?: true;
  organizer: OrganizerView | null;
}): { text: string; settings: boolean; warning: boolean } | null {
  if (card.missing) return { text: 'No longer listed in play-tools, for example cancelled. Shown so nothing here is lost.', settings: false, warning: true };
  if (card.unavailable) {
    return { text: "Couldn't check play-tools for this tournament, so it can't change now. Shown so nothing here is lost.", settings: false, warning: true };
  }
  const o = card.organizer;
  if (o?.needsReconnect) return { text: `Reconnect ${organizerName(o)} in Settings to log staff here.`, settings: true, warning: true };
  if (o && !o.connected) {
    return {
      text: `Only its organizer may log its staff. Connect Professor ${o.playerId}'s Pokémon account in Settings to log staff here.`,
      settings: true,
      warning: false,
    };
  }
  if (!card.editable) return { text: 'Read-only: more than 90 days past its start.', settings: false, warning: false };
  return null;
}

/** The Staff section's warning for a professor whose tournaments couldn't be read: reconnect, or Try again. */
export function unreadWarning(u: UnreadProfessor): { text: string; settings: boolean; retry: boolean } {
  const who = u.professor.playerId ? (u.professor.name ?? `Professor ${u.professor.playerId}`) : 'a Pokémon account';
  if (u.code === 'needs_reconnect') return { text: `Reconnect ${who} in Settings to see their tournaments.`, settings: true, retry: false };
  return { text: `Couldn't read ${who}'s tournaments from play-tools.`, settings: false, retry: true };
}

/** The Apply dialog's line on who the staff job runs as: always the tournament's organizer. */
export function runsAsText(organizer: Pick<OrganizerView, 'playerId' | 'name'>): string {
  return `Assigned as ${professorLabel({ professorPlayerId: organizer.playerId, professorName: organizer.name })}, who organizes this tournament.`;
}
