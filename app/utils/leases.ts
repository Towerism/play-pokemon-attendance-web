import type { CardLease, LeaseView, Lessee, NoticeState } from '../../server/modules/pokemon/leases';
import { dateIn, localDay } from '../../shared/time/local-time';
import type { SessionDate } from '../../shared/types/ids';

export type { CardLease, LeaseView, Lessee, NoticeState };

/** A card or row as its route answers it: with the tournament's live lease added (ADR-0015 §5). */
export type WithLease<T> = T & { lease?: CardLease | null };

/** `GET /api/tournament-leases`. */
export interface LeasesResponse {
  leases: LeaseView[];
  lessees: Lessee[];
}

/** The browser's time zone, the league's when the browser is at the store. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const DAY_MS = 86_400_000;
/** ADR-0015 §5: a lease lasts at most this long after its tournament starts. */
const MAX_AFTER_START_MS = 30 * DAY_MS;
/** How long a page keeps reading again while a notice is sending. */
const POLL_FOR_MS = 120_000;

/** "Sat, Nov 14": the last day a lease covers (it ends at the start of the next one). */
export function lastDayLabel(endsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.parse(endsAt) - 1));
}

export type LeaseLine = { kind: 'organizer' | 'lessee' | 'other'; leaseId: number; text: string };

/**
 * What a tournament card says about its lease (ADR-0015 §5): the organizer may end it, the lent professor may give it
 * back and act on the card, and everyone else learns who can change it. Null without a lease.
 */
export function leaseLine(lease: CardLease | null | undefined, viewerUserId: number | undefined, organizerIsMine: boolean, timeZone: string): LeaseLine | null {
  if (!lease) return null;
  const until = lastDayLabel(lease.endsAt, timeZone);
  if (organizerIsMine) return { kind: 'organizer', leaseId: lease.id, text: `Lent to ${lease.lesseeName} until ${until}` };
  if (viewerUserId === lease.lesseeUserId) return { kind: 'lessee', leaseId: lease.id, text: `Lent to you by ${lease.organizerName} until ${until}` };
  return { kind: 'other', leaseId: lease.id, text: `Only ${lease.organizerName} or ${lease.lesseeName} can change this` };
}

/** How a lease notice went, for the lent person named `name`; null when none applies. */
export function noticeLine(state: NoticeState | 'none' | null | undefined, name: string): string | null {
  switch (state) {
    case 'delivered':
      return 'Notice sent';
    case 'sending':
      return 'Sending notice…';
    case 'no_discord_user':
      return `No Discord account linked for ${name}; notice not sent`;
    case 'dm_refused':
      return `${name} doesn't accept DMs from Genie; notice not sent`;
    case 'undeliverable':
    case 'expired':
      return "Genie couldn't deliver the notice";
    case 'genie_unavailable':
      return "Genie isn't connected; no notice sent";
    case 'no_recipient':
      return `${name} has no Pokémon account connected; no notice sent`;
    default:
      return null;
  }
}

/** A picked end date, sent as the end of that day in `timeZone`. */
export function leaseEndsAt(date: string, timeZone: string): string {
  return localDay(date as SessionDate, timeZone).to.toISOString();
}

/**
 * The last date a lease of all these tournaments may run through: its end, the next midnight, stays within 30 days of
 * the earliest start. That is always the day before the limit's own date, since a day ends after any instant in it.
 */
export function latestEndDate(startsAt: readonly string[], timeZone: string): string | null {
  if (startsAt.length === 0) return null;
  const limit = Math.min(...startsAt.map((s) => Date.parse(s))) + MAX_AFTER_START_MS;
  const [y, m, d] = dateIn(new Date(limit), timeZone).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Whether to read the leases again: a notice is still sending, and the page hasn't waited 2 minutes yet. */
export function shouldPollLeases(leases: readonly { notice: NoticeState | null }[], firstReadAt: number, now: number): boolean {
  return now - firstReadAt < POLL_FOR_MS && leases.some((l) => l.notice === 'sending');
}
