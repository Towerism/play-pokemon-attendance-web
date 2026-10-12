/**
 * Pure decisions for the live S6 probe (spikes/s6-live.ts): which staffer it
 * may touch, whether the tournament still accepts staff, and whether the
 * staff list was restored afterwards.
 */

/** The Staff tab's role constant (play-tools bundle, spikes.md S6). `organizer` is fixed. */
export const ASSIGNABLE_ROLES = ['judge', 'headjudge', 'scorekeeper', 'administration', 'translator'] as const;

export interface Staff {
  recordId: string;
  playerId: string;
  role: string | null;
}

const DAY_MS = 86_400_000;
/** The UI enables adding staff until start + 90 d; keep a day back so a re-add can't fall outside it. */
const ADD_WINDOW_MS = 89 * DAY_MS;

export function toStaff(records: readonly unknown[]): Staff[] {
  return records.map((r) => {
    const rec = r as { guid?: unknown; role?: unknown; participant?: { player_id?: unknown } };
    const playerId = rec.participant?.player_id;
    if (typeof rec.guid !== 'string' || (typeof playerId !== 'string' && typeof playerId !== 'number')) {
      throw new Error(`unexpected staff record shape: keys ${Object.keys(rec as object).join(', ')}`);
    }
    return { recordId: rec.guid, playerId: String(playerId), role: typeof rec.role === 'string' ? rec.role : null };
  });
}

/** A non-organizer with an assignable role, on a tournament listing at least two staff. */
export function pickStaffer(staff: readonly Staff[]): Staff | undefined {
  if (staff.length < 2) return undefined;
  return staff.find((s) => (ASSIGNABLE_ROLES as readonly (string | null)[]).includes(s.role));
}

export function withinAddWindow(startIso: string | undefined, now: Date): boolean {
  const start = startIso ? Date.parse(startIso) : NaN;
  return Number.isFinite(start) && now.getTime() < start + ADD_WINDOW_MS;
}

/** A different assignable role for the change-role probe, preferring roles that need no judge certification. */
export function otherRole(role: string): string {
  const preference = ['administration', 'translator', 'scorekeeper', 'judge', 'headjudge'];
  return preference.find((r) => r !== role) as string;
}

export interface Repair {
  add: boolean;
  setRole: { recordId: string; role: string } | undefined;
  remove: Staff[];
  /** Staff other than the target that vanished; the probe never touches them. */
  othersMissing: Staff[];
}

/** What it takes to bring `after` back to `before`, touching only the target and records with `invalidId`. */
export function repairActions(before: readonly Staff[], after: readonly Staff[], target: Staff & { role: string }, invalidId: string): Repair {
  const mine = after.filter((s) => s.playerId === target.playerId);
  const keep = mine.find((s) => s.role === target.role) ?? mine[0];
  return {
    add: keep === undefined,
    setRole: keep && keep.role !== target.role ? { recordId: keep.recordId, role: target.role } : undefined,
    remove: [...mine.filter((s) => s !== keep), ...after.filter((s) => s.playerId === invalidId && !before.some((b) => b.recordId === s.recordId))],
    othersMissing: missingFrom(before, after).filter((s) => s.playerId !== target.playerId),
  };
}

/** Records for `playerId` in `after` that the snapshot `before` didn't have, i.e. what a probe added. */
export function addedFor(before: readonly Staff[], after: readonly Staff[], playerId: string): Staff[] {
  return after.filter((a) => a.playerId === playerId && !before.some((b) => b.recordId === a.recordId));
}

/** Entries of `before` with no record of the same player id and role in `after`. */
export function missingFrom(before: readonly Staff[], after: readonly Staff[]): Staff[] {
  return before.filter((b) => !after.some((a) => a.playerId === b.playerId && a.role === b.role));
}
