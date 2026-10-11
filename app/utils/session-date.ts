import { sessionDate } from '../../shared/schemas/sessions';

/** `YYYY-MM-DD` of `now` in the browser's timezone (the organizer is at the store). */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The `?date=` of the This week page, or today when it is missing or not a calendar date. */
export function sessionDateFromQuery(q: unknown, now: Date = new Date()): string {
  const parsed = sessionDate.safeParse(q);
  return parsed.success ? parsed.data : localDate(now);
}
