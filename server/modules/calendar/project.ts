import { dateIn } from '../../../shared/time/local-time';
import type { LiveLease } from '../pokemon/leases';
import type { LiveAssignment } from '../staffing/service';
import type { IcalCalendar, IcalEvent } from './ical';
import { type Snapshot, type SnapshotEvent, type SnapshotSource, sourcePlayerId } from './snapshot';

/**
 * What one feed shows from the league's snapshot, decided when it is fetched (ADR-0016 §2 and §5): the public feed's
 * events, or one user's with their part in each; the cancelled and not-confirmed marks; and what has aged out.
 */

export interface FeedContext {
  now: Date;
  leagueName: string;
  /** The league's IANA zone: dates in titles and descriptions are in it. */
  timeZone: string;
  /** 30 days back to 26 weeks ahead, from today. */
  range: { from: Date; to: Date };
  /** Sources whose professor no connection in the league has any more. */
  goneSources: ReadonlySet<string>;
}

export type FeedAudience =
  | { kind: 'public' }
  | {
      kind: 'user';
      /** The player IDs of the user's connections. */
      playerIds: ReadonlySet<string>;
      /** Their live staff assignments made in the app. */
      assignments: readonly LiveAssignment[];
      /** The live leases lent to them. */
      leases: readonly LiveLease[];
    };

const DAY = 86_400_000;
/** A cancelled or unconfirmed event stays this long after its start. */
const AFTER_START_MS = 7 * DAY;
/** A source whose reads have failed for longer than this marks its events unconfirmed. */
const STALE_MS = 14 * DAY;

export function projectFeed(snapshot: Snapshot, audience: FeedAudience, ctx: FeedContext): IcalCalendar {
  const sources = new Map(snapshot.sources.map((s) => [s.key, s]));
  const events: IcalEvent[] = [];
  for (const e of snapshot.events) {
    const start = new Date(e.startsAt).getTime();
    if (start < ctx.range.from.getTime() || start >= ctx.range.to.getTime()) continue;
    const since = unconfirmedSince(e, sources.get(e.source), ctx);
    if ((e.cancelled || since !== null) && start + AFTER_START_MS <= ctx.now.getTime()) continue;
    const part = audience.kind === 'public' ? publicPart(e) : userPart(e, audience, ctx.timeZone);
    if (!part) continue;
    events.push({
      uid: e.uid,
      start: new Date(e.startsAt),
      end: new Date(e.endsAt),
      summary: `${e.cancelled ? 'Cancelled: ' : ''}${e.name}${since === null ? '' : ` (not confirmed since ${since})`}`,
      description: [...part.lines, ...e.details].join('\n') || null,
      location: e.location,
      url: e.url,
      status: e.cancelled ? 'CANCELLED' : e.tentative ? 'TENTATIVE' : 'CONFIRMED',
      lastModified: new Date(Math.max(new Date(e.lastModified).getTime(), ...part.changedAt.map((d) => d.getTime()))),
    });
  }
  return {
    name: audience.kind === 'public' ? ctx.leagueName : `${ctx.leagueName}: my tournaments`,
    timeZone: ctx.timeZone,
    stamp: new Date(snapshot.builtAt),
    events,
  };
}

/** Sources Settings lists as stale, by name: gone, or failing with no successful read for over 14 days. */
export function staleSources(snapshot: Snapshot, ctx: Pick<FeedContext, 'now' | 'goneSources'>): { key: string; name: string | null; lastReadAt: string | null }[] {
  return snapshot.sources
    .filter((s) => ctx.goneSources.has(s.key) || failingTooLong(s, ctx.now))
    .map((s) => ({ key: s.key, name: s.name, lastReadAt: s.lastReadAt }))
    .sort((a, b) => (a.name ?? a.key).localeCompare(b.name ?? b.key));
}

interface Part {
  /** `DESCRIPTION` lines before the event's own. */
  lines: string[];
  /** When the user's part last changed, for `LAST-MODIFIED`. */
  changedAt: Date[];
}

/** The public feed: tournaments in play-tools, and play sessions. Planned rows not created yet are only in user feeds. */
function publicPart(e: SnapshotEvent): Part | null {
  return e.created ? { lines: [], changedAt: [] } : null;
}

/** The user's part in a tournament, or null when it isn't theirs. Sessions are never in a user feed. */
function userPart(e: SnapshotEvent, audience: Extract<FeedAudience, { kind: 'user' }>, timeZone: string): Part | null {
  if (e.kind !== 'tournament') return null;
  // The professor whose listing holds it organizes it; a template's organizer may have changed since it was created.
  const organizer = e.sourceConfirmed ? sourcePlayerId(e.source) : e.organizerPlayerId;
  const lines: string[] = [];
  const changedAt: Date[] = [];
  if (organizer !== null && audience.playerIds.has(organizer)) lines.push('You organize');
  if (!e.created) return lines.length > 0 ? { lines, changedAt } : null;
  for (const a of audience.assignments.filter((x) => x.tournamentId === e.tournamentId)) {
    lines.push(`Staff: ${a.roleLabel}`);
    changedAt.push(a.createdAt);
  }
  for (const l of audience.leases.filter((x) => x.tournamentId === e.tournamentId)) {
    // A lease ends at the first instant of the day after its last day.
    lines.push(`Lent to you until ${dateIn(new Date(l.endsAt.getTime() - 1), timeZone)}`);
    changedAt.push(l.grantedAt);
  }
  return lines.length > 0 ? { lines, changedAt } : null;
}

/** The local date of the source's last read when its events can't be confirmed, else null. */
function unconfirmedSince(e: SnapshotEvent, source: SnapshotSource | undefined, ctx: FeedContext): string | null {
  const gone = ctx.goneSources.has(e.source);
  if (!gone && !(source && failingTooLong(source, ctx.now))) return null;
  return dateIn(new Date(source?.lastReadAt ?? e.lastModified), ctx.timeZone);
}

function failingTooLong(s: SnapshotSource, now: Date): boolean {
  if (s.lastError === null) return false;
  return s.lastReadAt === null || now.getTime() - new Date(s.lastReadAt).getTime() > STALE_MS;
}
