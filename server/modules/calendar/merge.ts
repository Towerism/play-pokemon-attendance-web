import type { PlaySession } from '../pokemon/ports/play-tools-gateway';
import type { CalendarCheck, CalendarRead, CalendarTournament } from '../tournaments/service';
import {
  SESSIONS,
  type Snapshot,
  type SnapshotEvent,
  type SnapshotSource,
  isCreated,
  professorSource,
  sessionContent,
  sourcePlayerId,
  stamped,
  tournamentContent,
  uidOf,
} from './snapshot';

/**
 * How a refresh or a local rebuild becomes the next snapshot (ADR-0016 §3 and §5). The rule that matters most: an
 * event is cancelled or removed only when the app knows it is off. A failed read, a professor who is gone, a connection
 * with no player ID, or a details read that failed never removes or cancels anything; those events are kept as they were.
 */

/** The play-session listing: all three statuses read, or why not. */
export type SessionsRead = { ok: true; sessions: readonly PlaySession[] } | { ok: false; code: string };

export interface MergeInput {
  leagueId: string;
  now: Date;
  /** The instants the read covered: 30 days back to 26 weeks ahead, in the league's time zone. */
  range: { from: Date; to: Date };
  read: CalendarRead;
  /** null: the sessions weren't read (a local rebuild). */
  sessions: SessionsRead | null;
  /** The details reads `dropOuts` asked for, by tournament GUID. A missing answer keeps the event. */
  checks: ReadonlyMap<string, CalendarCheck>;
  /** Professors' names by player ID, for Settings' stale sources. */
  names: ReadonlyMap<string, string | null>;
}

/** A cancelled event stays this long after its start, so people see it was called off. */
const CANCELLED_KEPT_MS = 7 * 86_400_000;

/**
 * The created tournaments a refresh must make one details read of: in the last snapshot with a source a listing has
 * confirmed, starting inside the range, whose source's listing succeeded this time and that no listing held.
 */
export function dropOuts(previous: Snapshot | null, read: CalendarRead, range: MergeInput['range']): { tournamentId: string; playerId: string }[] {
  if (!previous || read.upstream !== 'read' || read.unmatched) return [];
  const listed = new Set(read.tournaments.flatMap((t) => (t.listedBy !== null && t.tournamentId !== null ? [t.tournamentId] : [])));
  const readOk = new Set(read.read);
  const out: { tournamentId: string; playerId: string }[] = [];
  for (const e of previous.events) {
    const playerId = sourcePlayerId(e.source);
    if (e.kind !== 'tournament' || !e.created || e.cancelled || !e.sourceConfirmed || e.tournamentId === null || playerId === null) continue;
    if (listed.has(e.tournamentId) || !readOk.has(playerId) || !inRange(e.startsAt, range)) continue;
    out.push({ tournamentId: e.tournamentId, playerId });
  }
  return out;
}

export function merge(previous: Snapshot | null, input: MergeInput): Snapshot {
  const { now, range, read } = input;
  const before = previous?.events ?? [];
  const byTournament = new Map(before.flatMap((e) => (e.tournamentId !== null ? [[e.tournamentId, e] as const] : [])));
  const byPlanned = new Map(before.flatMap((e) => (e.plannedId !== null ? [[e.plannedId, e] as const] : [])));
  /** Previous events this merge has decided about, so they aren't carried forward as well. */
  const decided = new Set<string>();
  const next: SnapshotEvent[] = [];

  for (const t of read.tournaments) {
    const byGuid = t.tournamentId === null ? undefined : byTournament.get(t.tournamentId);
    const byRow = t.plannedId === null ? undefined : byPlanned.get(t.plannedId);
    // A row that links to a tournament already published keeps that tournament's UID, the one in the public feed.
    const existing = byGuid ?? byRow;
    for (const e of [byGuid, byRow]) if (e) decided.add(e.uid);

    if (t.startsAt === null) {
      // A start a DST change skips or repeats: keep what was published until the row is fixed.
      if (existing) next.push(existing);
      continue;
    }
    const off = t.state === 'cancelled' || (t.state === 'skipped' && !isCreated(t));
    // A row skipped or cancelled before any snapshot held it never appears.
    if (off && (!existing || existing.kind !== 'tournament')) continue;
    next.push(tournamentEvent(t, existing, off, input));
  }

  // The tournaments a refresh found dropped out of their listing: only a details read decides.
  const checked = new Map<string, CalendarCheck>();
  for (const { tournamentId } of dropOuts(previous, read, range)) {
    const check = input.checks.get(tournamentId);
    if (check) checked.set(tournamentId, check);
  }
  const outcome = (e: SnapshotEvent): 'cancel' | 'remove' | 'keep' => {
    const check = e.tournamentId === null ? undefined : checked.get(e.tournamentId);
    if (check?.kind === 'cancelled') return 'cancel';
    if (check?.kind === 'exists' && check.startsAt !== null && !inRange(check.startsAt, range)) return 'remove';
    return 'keep';
  };
  const afterChecks: SnapshotEvent[] = [];
  for (const e of next) {
    const o = outcome(e);
    if (o === 'remove') continue;
    afterChecks.push(o === 'cancel' && !e.cancelled ? stamped({ ...e, cancelled: true }, e, now) : e);
  }

  // Previous tournament events this read said nothing about.
  for (const e of before) {
    if (e.kind !== 'tournament' || decided.has(e.uid)) continue;
    // A planned row that no longer exists (a schedule edit deleted it) was only ever tentative in its organizer's feed.
    if (!e.created) continue;
    const o = outcome(e);
    if (o === 'remove') continue;
    afterChecks.push(o === 'cancel' && !e.cancelled ? stamped({ ...e, cancelled: true }, e, now) : e);
  }

  const events = [...afterChecks, ...sessionEvents(before, input)].filter((e) => keptByDate(e, range, now)).sort(byStartThenUid);
  return { builtAt: now.toISOString(), events, sources: sources(previous?.sources ?? [], input) };
}

function tournamentEvent(t: CalendarTournament, existing: SnapshotEvent | undefined, off: boolean, input: MergeInput): SnapshotEvent {
  const listed = t.listedBy !== null;
  const prior = existing?.kind === 'tournament' ? existing : undefined;
  // A local read has no listing: keep the state the last listing reported, so a rebuild never confirms an unsanctioned tournament.
  const applicationState = listed ? t.applicationState : (prior?.applicationState ?? null);
  const source = listed
    ? { source: professorSource(t.listedBy!), sourceConfirmed: true }
    : prior
      ? { source: prior.source, sourceConfirmed: prior.sourceConfirmed }
      : { source: professorSource(t.organizerPlayerId ?? 'unknown'), sourceConfirmed: false };
  const uid = existing?.uid ?? (t.plannedId !== null ? uidOf(input.leagueId, 'planned', t.plannedId) : uidOf(input.leagueId, 'tournament', t.tournamentId!));
  return stamped(
    {
      uid,
      kind: 'tournament',
      plannedId: t.plannedId,
      tournamentId: t.tournamentId,
      sessionId: null,
      ...source,
      organizerPlayerId: t.organizerPlayerId,
      ...tournamentContent(t, applicationState),
      cancelled: off,
      applicationState,
      plannedState: t.plannedId === null ? null : t.state,
    },
    existing,
    input.now,
  );
}

function sessionEvents(before: readonly SnapshotEvent[], input: MergeInput): SnapshotEvent[] {
  const previous = before.filter((e) => e.kind === 'session');
  if (!input.sessions?.ok) return previous;
  const bySession = new Map(previous.map((e) => [e.sessionId!, e]));
  const listed = input.sessions.sessions.map((s) => {
    const existing = bySession.get(s.id);
    return stamped(
      {
        uid: existing?.uid ?? uidOf(input.leagueId, 'session', s.id),
        kind: 'session',
        plannedId: null,
        tournamentId: null,
        sessionId: s.id,
        source: SESSIONS,
        sourceConfirmed: true,
        organizerPlayerId: null,
        ...sessionContent(s),
        cancelled: false,
        applicationState: null,
        plannedState: null,
      },
      existing,
      input.now,
    );
  });
  const seen = new Set(input.sessions.sessions.map((s) => s.id));
  // A session a successful listing of every status no longer has is off; one outside the range wasn't looked for.
  const missing = previous
    .filter((e) => !seen.has(e.sessionId!))
    .map((e) => (!e.cancelled && inRange(e.startsAt, input.range) ? stamped({ ...e, cancelled: true }, e, input.now) : e));
  return [...listed, ...missing];
}

function sources(previous: readonly SnapshotSource[], input: MergeInput): SnapshotSource[] {
  const at = input.now.toISOString();
  const out = new Map(previous.map((s) => [s.key, s]));
  const touch = (key: string, name: string | null, error: string | null) => {
    const prior = out.get(key);
    out.set(key, {
      key,
      name: name ?? prior?.name ?? null,
      lastReadAt: error === null ? at : (prior?.lastReadAt ?? null),
      lastAttemptAt: at,
      lastError: error,
    });
  };
  if (input.read.upstream === 'read') {
    for (const playerId of input.read.read) touch(professorSource(playerId), input.names.get(playerId) ?? null, null);
    for (const f of input.read.failed) if (f.playerId !== null) touch(professorSource(f.playerId), input.names.get(f.playerId) ?? null, f.code);
  }
  if (input.sessions) touch(SESSIONS, null, input.sessions.ok ? null : input.sessions.code);
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function inRange(iso: string, range: MergeInput['range']): boolean {
  const t = new Date(iso).getTime();
  return t >= range.from.getTime() && t < range.to.getTime();
}

/** An event leaves when it started before the range, or 7 days after its start once cancelled. */
function keptByDate(e: SnapshotEvent, range: MergeInput['range'], now: Date): boolean {
  const start = new Date(e.startsAt).getTime();
  if (start < range.from.getTime()) return false;
  return !(e.cancelled && start + CANCELLED_KEPT_MS <= now.getTime());
}

function byStartThenUid(a: SnapshotEvent, b: SnapshotEvent): number {
  return a.startsAt.localeCompare(b.startsAt) || a.uid.localeCompare(b.uid);
}
