/** One professor's connection, as `GET /api/pokemon/connections` returns it (ADR-0008, ADR-0015). Never carries a token. */
export interface ProfessorConnectionJson {
  professorPlayerId: string | null;
  professorName: string | null;
  /** The full name written into a TDF whose organizer the app replaces (ADR-0011 decision 8). */
  professorFullName: string | null;
  status: 'connected' | 'needs_reconnect';
  reason: string | null;
  connectedAt: string;
  lastRefreshedAt: string;
  /** The viewer holds it: only they write to play-tools through it (ADR-0015 §2). */
  mine: boolean;
  membership: 'member' | 'outside' | 'unknown';
  /** A member allowed to record attendance for the league. */
  canSubmit: boolean;
}

/** The league's activity group (ADR-0015 §3): it names no connection. */
export interface LeagueJson {
  activityGroupId: string;
  displayName: string;
  displayId: string | null;
}

export interface ConnectionsResponse {
  connections: ProfessorConnectionJson[];
  league: LeagueJson | null;
}

/** Why a professor sees only Settings (ADR-0015 §3); null for a league member. */
export type WaitingReason = null | 'no_connection' | 'outside' | 'unknown';

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

/** The viewer's connections that can record attendance now: theirs, a member allowed to, and connected. */
const submitters = (r: Maybe<ConnectionsResponse>) => (r?.connections ?? []).filter((c) => c.mine && c.canSubmit && c.status === 'connected');

export type SubmitAsChoice =
  | { kind: 'one'; playerId: string; text: string }
  | { kind: 'several'; options: { value: string; label: string }[] }
  | { kind: 'none'; text: string };

/** What the submit dialog shows (ADR-0015 §4): who it submits as, a choice among the viewer's own, or that none can. */
export function submitAsChoice(r: Maybe<ConnectionsResponse>): SubmitAsChoice {
  const able = submitters(r);
  if (able.length === 1) return { kind: 'one', playerId: able[0]!.professorPlayerId!, text: `Submitting as ${professorLabel(able[0]!)}` };
  if (able.length > 1) return { kind: 'several', options: able.map((c) => ({ value: c.professorPlayerId!, label: professorLabel(c) })) };
  return { kind: 'none', text: `None of your Pokémon accounts can record attendance for ${r?.league?.displayName ?? 'the league'}.` };
}

/** The layout's banner: one of the viewer's own connections needs a reconnect (others' are theirs to fix). */
export function reconnectBanner(r: Maybe<ConnectionsResponse>): string | null {
  const stale = r?.connections.find((c) => c.mine && c.status === 'needs_reconnect');
  return stale ? `Pokémon no longer accepts ${professorShortLabel(stale)}’s login. Reconnect it in Settings.` : null;
}

/**
 * "Only <professor> can change this", where another user holds the organizer's connection (ADR-0015 §4). Null when the
 * viewer holds it, or when nobody has that player id connected: the existing "connect the organizer" notices apply.
 */
export function onlyText(r: Maybe<ConnectionsResponse>, organizerPlayerId: string | null | undefined): string | null {
  const c = organizerPlayerId ? r?.connections.find((x) => x.professorPlayerId === organizerPlayerId) : undefined;
  return c && !c.mine ? `Only ${professorLabel(c)} can change this` : null;
}

export interface OrganizerOption {
  value: string;
  label: string;
  disabled: boolean;
  description?: string;
}

/** The template form's organizer choices: the viewer's own connections, plus another's current one shown, not pickable. */
export function organizerOptions(r: Maybe<ConnectionsResponse>, current: string | null): OrganizerOption[] {
  const all = r?.connections ?? [];
  const mine: OrganizerOption[] = all
    .filter((c) => c.mine && c.professorPlayerId)
        // The form reads the organizer's venues and series from play-tools, so a login needing a reconnect can't be picked.
    .map((c) => ({ value: c.professorPlayerId!, label: professorLabel(c), disabled: c.status !== 'connected', ...(c.status !== 'connected' && { description: 'Reconnect in Settings' }) }));
  const theirs = current ? all.find((c) => c.professorPlayerId === current && !c.mine) : undefined;
  if (!theirs) return mine;
  return [...mine, { value: current!, label: professorLabel(theirs), disabled: true, description: `Only ${professorShortLabel(theirs)} can choose this` }];
}

/** A create's rows refused because another user holds their organizer (ADR-0015 §4), as one line; null when none. */
export function refusedText(
  r: Maybe<ConnectionsResponse>,
  refused: readonly { plannedTournamentId: number; professorPlayerId: string }[],
  labelOf: (plannedTournamentId: number) => string,
): string | null {
  if (refused.length === 0) return null;
  const parts = refused.map((x) => {
    const c = r?.connections.find((y) => y.professorPlayerId === x.professorPlayerId);
    const who = c ? professorLabel(c) : `Professor ${x.professorPlayerId}`;
    return `only ${who} can create ${labelOf(x.plannedTournamentId)}`;
  });
  return `Left out: ${parts.join('; ')}.`;
}

/** Why a professor sees only Settings (ADR-0015 §3). */
export function waitingText(waiting: WaitingReason, leagueName: string | null): string | null {
  if (waiting === 'no_connection') return 'Connect your Pokémon account to use the league.';
  if (waiting === 'outside') return `Your Pokémon account isn't in ${leagueName ?? 'the league'} in play-tools.`;
  if (waiting === 'unknown') return 'Checking your Pokémon account’s league…';
  return null;
}

/** Why the staff and player imports can't start yet: they read every connection in the league. */
export function importsBlocked(r: Maybe<ConnectionsResponse>): string | null {
  const readable = (r?.connections ?? []).filter((c) => c.membership !== 'outside');
  if (readable.length === 0) return 'Connect a Pokémon account first.';
  if (readable.every((c) => c.status === 'needs_reconnect')) return 'Reconnect the Pokémon account first.';
  if (!r?.league) return 'Choose the league first.';
  return null;
}

/** Who started a History entry, and as which professor when that was recorded; an import reads as every one (#75). */
export function startedByText(s: { startedBy: string; professor: { playerId: string; name: string | null } | null; kind?: string }): string {
  const everyone = s.kind === 'staff_import' || s.kind === 'player_import';
  if (!s.professor) return everyone ? `${s.startedBy}, as every connected professor` : s.startedBy;
  return `${s.startedBy}, as ${professorLabel({ professorPlayerId: s.professor.playerId, professorName: s.professor.name })}`;
}

/** Under the league picker: which of the owner's connections it leaves out because their login needs a reconnect. */
export function excludedText(excluded: readonly { playerId: string | null; name: string | null }[]): string | null {
  if (!excluded.length) return null;
  const names = excluded.map((p) => professorShortLabel({ professorPlayerId: p.playerId, professorName: p.name }));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} ${names.length === 1 ? "isn't" : "aren't"} included until reconnected.`;
}

/** The league picker when none of the owner's connections manages a league in play-tools (ADR-0015 §3). */
export const NO_LEAGUE = "None of your Pokémon accounts manages a league in play-tools.";

/**
 * Why History offers no Retry or Undo for an attempt, if it doesn't (ADR-0015 §4): it ran as another user's connection,
 * no professor was recorded for it, or it is an import, which is the owner's.
 */
export function historyLock(
  r: Maybe<ConnectionsResponse>,
  s: { kind: string; professor: { playerId: string } | null },
  role: 'owner' | 'professor' | undefined,
): string | null {
  if (s.kind === 'staff_import' || s.kind === 'player_import') return role === 'owner' ? null : 'Only the owner can run an import.';
  if (!s.professor) return 'No professor was recorded for this attempt, so it can’t be retried or undone.';
  return onlyText(r, s.professor.playerId);
}
