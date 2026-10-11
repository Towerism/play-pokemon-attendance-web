import type { SessionDate } from '../../../shared/types/ids';
import type { DateRange, PlaySession } from '../pokemon/ports/play-tools-gateway';

/**
 * A session date as the UTC instants of its local midnights (§4.4). Upstream
 * times are UTC, and an evening session can start on the next UTC day (S3),
 * so dates always mean the league timezone. DST days are 23 or 25 hours.
 */
export function localDay(date: SessionDate, timeZone: string): DateRange {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { from: localMidnight(y, m, d, timeZone), to: localMidnight(y, m, d + 1, timeZone) };
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

const PRODUCTS: Record<string, string> = { tcg: 'TCG', vg: 'VG', pgo: 'GO' };

/** e.g. "Open play · TCG, VG · Tue 6:00 PM"; upstream sessions have no title (S3). */
export function sessionLabel(session: Pick<PlaySession, 'type' | 'products' | 'startsAt'>, timeZone: string): string {
  const type = session.type.replaceAll('_', ' ');
  const products = session.products.map((p) => PRODUCTS[p] ?? p.toUpperCase()).join(', ');
  const start = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' })
    .format(session.startsAt)
    .replace(/\s/gu, ' '); // some ICU versions put a narrow no-break space before AM/PM
  return [type.charAt(0).toUpperCase() + type.slice(1), products, start].filter(Boolean).join(' · ');
}
