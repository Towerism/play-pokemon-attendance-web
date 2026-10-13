import { parseLocalDate } from '../../../shared/time/local-time';

/** A calendar date, `YYYY-MM-DD`, with no time zone of its own. Compared as strings. */
export type LocalDate = string;

const DAY_MS = 86_400_000;

/** `date` moved by whole calendar days. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = parseLocalDate(date);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** `date` moved by whole months; a day the target month lacks becomes its last day (Feb 29 → Feb 28). */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const [y, m, d] = parseLocalDate(date);
  const length = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, length))).toISOString().slice(0, 10);
}

