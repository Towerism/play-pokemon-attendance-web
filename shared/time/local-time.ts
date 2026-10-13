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

/** A wall time that isn't exactly one instant: skipped by a DST gap, or repeated by an overlap. */
export class LocalTimeError extends RangeError {
  constructor(
    readonly reason: 'nonexistent' | 'ambiguous',
    date: string,
    time: string,
    timeZone: string,
  ) {
    super(`${date} ${time} is ${reason === 'nonexistent' ? 'skipped' : 'repeated'} by a DST change in ${timeZone}`);
    this.name = 'LocalTimeError';
  }
}

/**
 * The UTC instant at which the wall clock of `timeZone` shows `date` `time`
 * (`YYYY-MM-DD`, `HH:MM`), e.g. a tournament's start at its venue. A time a
 * DST change skips or repeats is refused, never shifted or guessed.
 */
export function localInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = parseLocalDate(date);
  const [hh, mm] = parseLocalTime(time);
  const instants = instantsAt(Date.UTC(y, m - 1, d, hh, mm), timeZone);
  if (instants.length === 0) throw new LocalTimeError('nonexistent', date, time, timeZone);
  if (instants.length > 1) throw new LocalTimeError('ambiguous', date, time, timeZone);
  return new Date(instants[0]!);
}

/** `YYYY-MM-DD` as [year, month, day], refusing anything that isn't a real calendar date. */
export function parseLocalDate(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  const [y, m, d] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  const at = new Date(Date.UTC(y, m - 1, d));
  if (!match || at.getUTCFullYear() !== y || at.getUTCMonth() !== m - 1 || at.getUTCDate() !== d) {
    throw new RangeError(`Invalid date ${JSON.stringify(date)}: expected a real YYYY-MM-DD date`);
  }
  return [y, m, d];
}

/** `HH:MM` (00:00–23:59) as [hours, minutes]. */
export function parseLocalTime(time: string): [number, number] {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(time);
  if (!match) throw new RangeError(`Invalid time ${JSON.stringify(time)}: expected HH:MM, 00:00–23:59`);
  return [Number(match[1]), Number(match[2])];
}

/** Every instant whose wall clock in `timeZone` reads `wall`: none in a DST gap, two in an overlap. */
function instantsAt(wall: number, timeZone: string): number[] {
  // The offsets a day either side cover both sides of any DST change near `wall`.
  const offsets = new Set([offsetMs(new Date(wall - DAY_MS), timeZone), offsetMs(new Date(wall + DAY_MS), timeZone)]);
  return [...offsets]
    .map((offset) => wall - offset)
    .filter((at) => offsetMs(new Date(at), timeZone) === wall - at)
    .sort((a, b) => a - b);
}

const DAY_MS = 86_400_000;

function localMidnight(y: number, m: number, d: number, timeZone: string): Date {
  const wall = Date.UTC(y, m - 1, d);
  // Two passes: the offset at the guess can differ from the offset at the answer around a DST change.
  let at = wall - offsetMs(new Date(wall), timeZone);
  at = wall - offsetMs(new Date(at), timeZone);
  return new Date(at);
}

/** A formatter per zone: building one costs far more than using it, and a schedule asks hundreds of times. */
const wallClocks = new Map<string, Intl.DateTimeFormat>();

function wallClock(timeZone: string): Intl.DateTimeFormat {
  let format = wallClocks.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    wallClocks.set(timeZone, format);
  }
  return format;
}

/** How far the zone's wall clock is ahead of UTC at `instant`. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    wallClock(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}
