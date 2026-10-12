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
