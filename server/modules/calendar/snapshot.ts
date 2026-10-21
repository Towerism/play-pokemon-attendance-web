import { createHash } from 'node:crypto';
import { formatAdmission } from '../../../shared/money/admission';
import type { PlaySession } from '../pokemon/ports/play-tools-gateway';
import { sessionTitle } from '../submission/local-time';
import { safeUri } from './ical';
import type { CalendarTournament } from '../tournaments/service';

/**
 * The stored snapshot every feed of a league is served from (ADR-0016 §5), and how one event of it is built. Pure:
 * every function here takes `now` and its inputs, and reads nothing else.
 */

/** One event, as stored. Its title marks (cancelled, not confirmed) are added when a feed is served. */
export interface SnapshotEvent {
  uid: string;
  kind: 'tournament' | 'session';
  plannedId: number | null;
  tournamentId: string | null;
  sessionId: string | null;
  /** `professor:<player id>` (whose listing holds the tournament) or `sessions`. */
  source: string;
  /** A listing has held it; a provisional source (a tournament the app just created) never cancels it. */
  sourceConfirmed: boolean;
  /** In play-tools: shown in the public feed. A planned row not created yet is only in its organizer's feed. */
  created: boolean;
  /** The template's organizer for a planned row; the listing's for a play-tools tournament. */
  organizerPlayerId: string | null;
  name: string;
  /** ISO UTC. */
  startsAt: string;
  /** ISO UTC; the default length applied when play-tools gives no end. */
  endsAt: string;
  location: string | null;
  /** `DESCRIPTION` lines after a user feed's own part. */
  details: string[];
  url: string | null;
  tentative: boolean;
  cancelled: boolean;
  /** The last sanctioning state a listing reported, kept through local rebuilds. */
  applicationState: string | null;
  /** The planned row's state, to see a row become skipped or cancelled. */
  plannedState: string | null;
  /** SHA-256 of what the event shows; `lastModified` moves only when it changes. */
  contentHash: string;
  /** ISO UTC. */
  lastModified: string;
}

/** A source's last read, for the stale marks (ADR-0016 §5). */
export interface SnapshotSource {
  key: string;
  /** The professor's name, for Settings; null for `sessions`. */
  name: string | null;
  lastReadAt: string | null;
  lastAttemptAt: string | null;
  /** The last attempt's error code; null when it succeeded. */
  lastError: string | null;
  /** The first failed attempt since the last successful read; null while reads succeed. */
  failingSince: string | null;
}

export interface Snapshot {
  /** ISO UTC; every event's `DTSTAMP`. */
  builtAt: string;
  events: SnapshotEvent[];
  sources: SnapshotSource[];
}

export const SESSIONS = 'sessions';
export const professorSource = (playerId: string) => `professor:${playerId}`;
export const sourcePlayerId = (key: string) => (key.startsWith('professor:') ? key.slice('professor:'.length) : null);

const HOUR = 3_600_000;
/** ADR-0016 Q2: play-tools gives tournaments no end. */
export const TOURNAMENT_HOURS = 4;
export const SESSION_HOURS = 3;

/** As the Tournaments page shows the game. */
const GAME: Record<string, string> = { tcg: 'TCG', vg: 'VGC', pgo: 'GO' };

export function uidOf(leagueId: string, kind: 'planned' | 'tournament' | 'session', id: string | number): string {
  return `${kind}-${id}@${leagueId}.play-pokemon-attendance`;
}

/**
 * A created tournament: in play-tools, so in the public feed. Any row holding a GUID is one, whatever its state: a row
 * skipped while its create was unknown and then linked still names a live tournament. A row still `creating` or
 * `unknown` has no GUID yet and counts as planned.
 */
export function isCreated(t: Pick<CalendarTournament, 'tournamentId'>): boolean {
  return t.tournamentId !== null;
}

/** The parts of an event that come from a tournament; identity, source and dates of change are the caller's. */
export function tournamentContent(t: CalendarTournament, applicationState: string | null) {
  const start = new Date(t.startsAt!);
  const game = t.product ? (GAME[t.product] ?? t.product.toUpperCase()) : null;
  const created = isCreated(t);
  const website = safeUri(t.eventWebsite);
  const details = [game, registrationLine(t.registration), website && `Event website: ${website}`].filter((x): x is string => !!x);
  return {
    name: t.name ?? (game ? `${game} tournament` : 'Tournament'),
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + TOURNAMENT_HOURS * HOUR).toISOString(),
    location: t.venueLabel,
    details,
    url: website,
    created,
    tentative: !created || applicationState !== 'sanctioned',
  };
}

export function sessionContent(s: PlaySession) {
  return {
    name: sessionTitle(s),
    startsAt: s.startsAt.toISOString(),
    endsAt: (s.endsAt ?? new Date(s.startsAt.getTime() + SESSION_HOURS * HOUR)).toISOString(),
    location: null,
    details: [] as string[],
    url: null,
    created: true,
    tentative: false,
  };
}

function registrationLine(r: CalendarTournament['registration']): string | null {
  if (!r) return null;
  if (r.kind === 'third_party') {
    const url = safeUri(r.url);
    return url && `Registration: ${url}`;
  }
  const amount = formatAdmission(r.admissionCents);
  const admission = amount ? ` Admission: ${amount}` : '';
  return `Registration on site opens ${r.opensBeforeMin} min before the start and closes ${r.closesAfterMin} min after.${admission}`;
}

/** Hash of what an event shows, so `LAST-MODIFIED` moves only when that changes (ADR-0016 §3). */
export function contentHash(e: Pick<SnapshotEvent, 'name' | 'startsAt' | 'endsAt' | 'location' | 'details' | 'url' | 'tentative' | 'cancelled'>): string {
  const shown = [e.name, e.startsAt, e.endsAt, e.location, e.details, e.url, e.tentative, e.cancelled];
  return createHash('sha256').update(JSON.stringify(shown)).digest('hex');
}

/** `event` with its hash, and its `lastModified` kept unless what it shows changed. */
export function stamped(event: Omit<SnapshotEvent, 'contentHash' | 'lastModified'>, previous: SnapshotEvent | undefined, now: Date): SnapshotEvent {
  const hash = contentHash(event);
  return { ...event, contentHash: hash, lastModified: previous && previous.contentHash === hash ? previous.lastModified : now.toISOString() };
}
