import { localInstant, LocalTimeError, parseLocalDate, parseLocalTime } from '../time/local-time';
import { scheduleRuleSchema, type Nth, type ScheduleRule, type Weekday } from './rule';

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
  if (!scheduleRuleSchema.safeParse(rule).success) throw new RangeError(`Invalid schedule rule ${JSON.stringify(rule)}`);
  const startsOn = dayNumber(bounds.startsOn);
  const endsOn = bounds.endsOn == null ? Infinity : dayNumber(bounds.endsOn);
  const [rangeFrom, rangeTo] = [dayNumber(range.from), dayNumber(range.to)];
  // The longest legitimate range is today − 2 days to 12 months ahead (create through, ADR-0010 decision 5).
  if (rangeTo - rangeFrom + 1 > MAX_RANGE_DAYS) {
    throw new RangeError(`Range ${range.from} … ${range.to} is longer than ${MAX_RANGE_DAYS} days`);
  }
  const from = Math.max(rangeFrom, startsOn);
  const to = Math.min(rangeTo, endsOn);
  if (from > to) return [];
  const days = rule.kind === 'weekly' ? weeklyDays(rule, startsOn, from, to) : monthlyDays(rule, from, to);
  return days.map(localDate);
}

/** A scaffold slot, its start time already resolved (slot override, else the template's). */
export interface ScheduleSlot {
  position: number;
  /** Days after the scaffold's date, 0–6. */
  dayOffset: number;
  /** `HH:MM`, local to the venue. */
  startTime: string;
}

export interface ExpandableSchedule extends DateBounds {
  rule: ScheduleRule;
  slots: readonly ScheduleSlot[];
  /** The venue's IANA time zone. */
  timeZone: string;
}

export interface Occurrence {
  /** The scaffold's date: with the schedule and the slot position, a planned tournament's key. */
  occurrenceDate: LocalDate;
  slotPosition: number;
  /** `occurrenceDate` + the slot's day offset. */
  localDate: LocalDate;
  startTime: string;
  /** The start at the venue as a UTC instant; null when a DST change skips or repeats that time. */
  startsAt: Date | null;
  /** Set only when `startsAt` is null. */
  timeProblem?: LocalTimeError['reason'];
}

/**
 * Every slot of the scaffold for each date the schedule produces in `range`.
 * The range filters on the scaffold's date, so a back-to-back set is never
 * split (ADR-0010 decision 5). A start that can't be placed (a DST gap or
 * overlap) is marked on its occurrence alone; the rest still plan.
 */
export function expandSchedule(schedule: ExpandableSchedule, range: LocalDateRange): Occurrence[] {
  new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone }); // throws a RangeError naming an unknown zone
  const positions = new Set<number>();
  for (const slot of schedule.slots) {
    if (!Number.isInteger(slot.dayOffset) || slot.dayOffset < 0 || slot.dayOffset > 6) {
      throw new RangeError(`Invalid day offset ${slot.dayOffset} for slot position ${slot.position}: expected 0–6`);
    }
    if (positions.has(slot.position)) throw new RangeError(`Duplicate slot position ${slot.position}`);
    positions.add(slot.position);
    parseLocalTime(slot.startTime);
  }

  const occurrences = occurrenceDates(schedule.rule, schedule, range).flatMap((occurrenceDate) =>
    schedule.slots.map((slot) => {
      const localDate = addDays(occurrenceDate, slot.dayOffset);
      const base = { occurrenceDate, slotPosition: slot.position, localDate, startTime: slot.startTime };
      try {
        return { ...base, startsAt: localInstant(localDate, slot.startTime, schedule.timeZone) };
      } catch (error) {
        if (error instanceof LocalTimeError) return { ...base, startsAt: null, timeProblem: error.reason };
        throw error;
      }
    }),
  );
  return occurrences.sort(
    (a, b) =>
      a.occurrenceDate.localeCompare(b.occurrenceDate) ||
      a.localDate.localeCompare(b.localDate) ||
      a.startTime.localeCompare(b.startTime) ||
      a.slotPosition - b.slotPosition,
  );
}

function addDays(date: LocalDate, days: number): LocalDate {
  return localDate(dayNumber(date) + days);
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
  for (let month = monthIndex(from); month <= monthIndex(to); month++) {
    const [y, m] = [Math.floor(month / 12), month % 12];
    // Quarters follow the calendar: month 1 of a quarter is January, April, July or October.
    if (rule.kind === 'quarterly' && m % 3 !== rule.month - 1) continue;
    const day = 'nth' in rule ? nthWeekday(y, m, rule.nth, rule.weekday) : dayOfMonth(y, m, rule.day);
    if (day >= from && day <= to) days.push(day);
  }
  return days;
}

/** Months since year 0 (`year × 12 + month`, month 0-based) of a day number. */
function monthIndex(day: number): number {
  const date = new Date(day * DAY_MS);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
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
const MAX_RANGE_DAYS = 400;
