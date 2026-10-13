/** One professor's connection, as `GET /api/pokemon/connections` returns it (ADR-0008). Never carries a token. */
export interface ProfessorConnectionJson {
  professorPlayerId: string | null;
  professorName: string | null;
  status: 'connected' | 'needs_reconnect';
  reason: string | null;
  connectedAt: string;
  lastRefreshedAt: string;
  submitsForLeague: boolean;
}

export interface LeagueBindingJson {
  professorPlayerId: string | null;
  activityGroupId: string;
  displayName: string;
  displayId: string | null;
  canSubmit: boolean;
}

export interface ConnectionsResponse {
  connections: ProfessorConnectionJson[];
  league: LeagueBindingJson | null;
}

type Maybe<T> = T | null | undefined;

/**
 * "Ash Ketchum (0012345)" with the organizer's display name; "Professor 0012345" without one; "Identifying…" for a
 * carried-over connection not yet identified. Used where telling professors apart matters (Settings, the league
 * picker, the submit dialog, History).
 */
export function professorLabel(c: Pick<ProfessorConnectionJson, 'professorPlayerId' | 'professorName'>): string {
  if (!c.professorPlayerId) return 'Identifying…';
  return c.professorName ? `${c.professorName} (${c.professorPlayerId})` : `Professor ${c.professorPlayerId}`;
}

/** The display name alone, else "Professor <player id>": for the banner and toasts. */
export function professorShortLabel(c: Pick<ProfessorConnectionJson, 'professorPlayerId' | 'professorName'>): string {
  if (!c.professorPlayerId) return 'Identifying…';
  return c.professorName ?? `Professor ${c.professorPlayerId}`;
}

/** The connection that makes the league's upstream calls, if one is chosen. */
export function submittingProfessor(r: Maybe<ConnectionsResponse>): ProfessorConnectionJson | null {
  return r?.connections.find((c) => c.submitsForLeague) ?? null;
}

/** The league-level view the submit and staff checks read: the submitting professor's status and the league. */
export function leagueConnection(r: Maybe<ConnectionsResponse>): {
  status: 'connected' | 'needs_reconnect' | 'not_connected';
  league: { id: string; name: string; displayId: string | null; canSubmit: boolean } | null;
} {
  const submitting = submittingProfessor(r);
  const status = submitting ? submitting.status : r?.connections.length ? 'connected' : 'not_connected';
  const league = r?.league ? { id: r.league.activityGroupId, name: r.league.displayName, displayId: r.league.displayId, canSubmit: r.league.canSubmit } : null;
  return { status, league };
}

/** The global banner's text: only when the league's submitting professor needs a reconnect (others are flagged in Settings). */
export function reconnectBanner(r: Maybe<ConnectionsResponse>): string | null {
  const submitting = submittingProfessor(r);
  if (submitting?.status !== 'needs_reconnect') return null;
  return `Pokémon no longer accepts ${professorShortLabel(submitting)}’s login. Reconnect before submitting attendance.`;
}

/** "Submitting as Brock Harrison (0000222)", for the submit dialog. */
export function submitAsText(r: Maybe<ConnectionsResponse>): string | null {
  const submitting = submittingProfessor(r);
  return submitting ? `Submitting as ${professorLabel(submitting)}` : null;
}

/** Who started a History entry, and as which professor when that was recorded; an import reads as every one (#75). */
export function startedByText(s: { startedBy: string; professor: { playerId: string; name: string | null } | null; kind?: string }): string {
  const everyone = s.kind === 'staff_import' || s.kind === 'player_import';
  if (!s.professor) return everyone ? `${s.startedBy}, as every connected professor` : s.startedBy;
  return `${s.startedBy}, as ${professorLabel({ professorPlayerId: s.professor.playerId, professorName: s.professor.name })}`;
}

/** Under the league picker: who the shared leagues leave out because their login needs a reconnect (#75). */
export function excludedText(excluded: readonly { playerId: string | null; name: string | null }[]): string | null {
  if (!excluded.length) return null;
  const names = excluded.map((p) => professorShortLabel({ professorPlayerId: p.playerId, professorName: p.name }));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? "isn't" : "aren't"} included until reconnected.`;
}

/** The league picker when the connected professors share no league in play-tools (#75). */
export const NO_SHARED_LEAGUE = "These professors share no league in play-tools. Disconnect the one who isn't in your league.";
