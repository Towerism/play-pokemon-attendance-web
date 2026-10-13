import { parseLocalDate } from '../time/local-time';
import type { Nth, ScheduleRule, Weekday } from './rule';

/** A calendar date, `YYYY-MM-DD`, with no time zone of its own. */
export type LocalDate = string;

export interface DateBounds {
  startsOn: LocalDate;
  endsOn?: LocalDate | null;
}

/** Inclusive at both ends. */
export interface LocalDateRange {
  from: LocalDate;
  to: LocalDate;
}

/**
 * The dates `rule` produces inside both the schedule's bounds and `range`,
 * ascending (ADR-0010 decision 3). Pure: no clock, and calendar maths only
 * (whole days since the epoch), so the host's time zone never matters.
 */
export function occurrenceDates(rule: ScheduleRule, bounds: DateBounds, range: LocalDateRange): LocalDate[] {
  const startsOn = dayNumber(bounds.startsOn);
  const from = Math.max(dayNumber(range.from), startsOn);
  const to = Math.min(dayNumber(range.to), bounds.endsOn == null ? Infinity : dayNumber(bounds.endsOn));
  if (from > to) return [];
  const days = rule.kind === 'weekly' ? weeklyDays(rule, startsOn, from, to) : monthlyDays(rule, from, to);
  return days.map(localDate);
}

function weeklyDays(rule: Extract<ScheduleRule, { kind: 'weekly' }>, startsOn: number, from: number, to: number): number[] {
  // The phase of an every-N-weeks rule comes from the schedule's first date, never from the range.
  const first = startsOn + ((rule.weekday - isoWeekday(startsOn) + 7) % 7);
  const step = rule.every * 7;
  const days: number[] = [];
  for (let day = first + Math.max(0, Math.ceil((from - first) / step)) * step; day <= to; day += step) days.push(day);
  return days;
}

/** At most one date per calendar month, kept when it lands inside [from, to]. */
function monthlyDays(rule: Exclude<ScheduleRule, { kind: 'weekly' }>, from: number, to: number): number[] {
  const days: number[] = [];
  const start = new Date(from * DAY_MS);
  const end = new Date(to * DAY_MS);
  for (let y = start.getUTCFullYear(), m = start.getUTCMonth(); y * 12 + m <= end.getUTCFullYear() * 12 + end.getUTCMonth(); m === 11 ? (y++, (m = 0)) : m++) {
    // Quarters follow the calendar: month 1 of a quarter is January, April, July or October.
    if (rule.kind === 'quarterly' && m % 3 !== rule.month - 1) continue;
    const day = 'nth' in rule ? nthWeekday(y, m, rule.nth, rule.weekday) : dayOfMonth(y, m, rule.day);
    if (day >= from && day <= to) days.push(day);
  }
  return days;
}

/** Day `day` of the month, or the month's last day when it is shorter. */
function dayOfMonth(y: number, m: number, day: number): number {
  const length = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, length)) / DAY_MS;
}

/** The nth (or last) `weekday` of month `m` (0-based) of year `y`, as a day number. */
function nthWeekday(y: number, m: number, nth: Nth, weekday: Weekday): number {
  if (nth === 'last') {
    const lastDay = Date.UTC(y, m + 1, 0) / DAY_MS;
    return lastDay - ((isoWeekday(lastDay) - weekday + 7) % 7);
  }
  const firstDay = Date.UTC(y, m, 1) / DAY_MS;
  return firstDay + ((weekday - isoWeekday(firstDay) + 7) % 7) + (nth - 1) * 7;
}

/** Whole days since 1970-01-01. */
function dayNumber(date: LocalDate): number {
  const [y, m, d] = parseLocalDate(date);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function localDate(day: number): LocalDate {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday. Day 0 (1970-01-01) was a Thursday. */
function isoWeekday(day: number): number {
  return ((((day + 3) % 7) + 7) % 7) + 1;
}

const DAY_MS = 86_400_000;
