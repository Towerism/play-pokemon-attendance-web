/** A calendar date, `YYYY-MM-DD`, compared as a string. */
export type LocalDate = string;

export type Cadence = 'month' | 'quarter';

/** A requirement's calendar month or quarter, first and last days inclusive (ADR-0010 decision 12, #102). */
export interface Period {
  start: LocalDate;
  end: LocalDate;
}

const DAY_MS = 86_400_000;

const iso = (ms: number): LocalDate => new Date(ms).toISOString().slice(0, 10);

function parts(date: LocalDate): [number, number, number] {
  return date.split('-').map(Number) as [number, number, number];
}

/** `date` moved by whole calendar days. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = parts(date);
  return iso(Date.UTC(y, m - 1, d) + days * DAY_MS);
}

/** The period of `months` months starting at month index `index` (0-based, may run past a year). */
function span(year: number, index: number, months: number): Period {
  return { start: iso(Date.UTC(year, index, 1)), end: iso(Date.UTC(year, index + months, 0)) };
}

const MONTHS: Record<Cadence, number> = { month: 1, quarter: 3 };

/**
 * The periods coverage shows for a cadence on `today` (league `TZ`): the previous one, so a missed or last-chance
 * period stays on screen, the current one, and what follows (the next two months, or the next quarter).
 */
export function periodsFor(cadence: Cadence, today: LocalDate): Period[] {
  const [y, m] = parts(today);
  const size = MONTHS[cadence];
  const first = Math.floor((m - 1) / size) * size;
  const offsets = cadence === 'month' ? [-1, 0, 1, 2] : [-1, 0, 1];
  return offsets.map((o) => span(y, first + o * size, size));
}

/** The period of `cadence` that starts on `start`, or null when `start` isn't the first day of one. */
export function periodOf(cadence: Cadence, start: LocalDate): Period | null {
  const [y, m, d] = parts(start);
  const period = span(y, m - 1, MONTHS[cadence]);
  return d === 1 && (m - 1) % MONTHS[cadence] === 0 && period.start === start ? period : null;
}
