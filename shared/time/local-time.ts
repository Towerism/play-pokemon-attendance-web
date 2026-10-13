import type { SessionDate } from '../types/ids';

/**
 * A session date as the UTC instants of its local midnights (§4.4). Upstream
 * times are UTC, and an evening session can start on the next UTC day (S3),
 * so dates always mean the league timezone. DST days are 23 or 25 hours.
 */
export function localDay(date: SessionDate, timeZone: string): { from: Date; to: Date } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { from: localMidnight(y, m, d, timeZone), to: localMidnight(y, m, d + 1, timeZone) };
}

/** The calendar date of `instant` on the wall clock of `timeZone`. */
export function dateIn(instant: Date, timeZone: string): SessionDate {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant) as SessionDate;
}

function localMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const wall = Date.UTC(y, m - 1, d);
  // Two passes: the offset at the guess can differ from the offset at the answer around a DST change.
  let at = wall - offsetMs(new Date(wall), timeZone);
  at = wall - offsetMs(new Date(at), timeZone);
  return new Date(at);
}

/** How far the zone's wall clock is ahead of UTC at `instant`. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(instant)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}
