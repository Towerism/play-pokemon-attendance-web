import { addDays, todayIn } from '../../app/utils/dates';

/**
 * The date `days` calendar days after `now`'s date in `timeZone`, as the server sees it (YYYY-MM-DD).
 * Counts whole days from today's league date, so a DST change before the target can't shift it (#155). Built from
 * the app's own date helpers (#98), so the tests and the Tournaments page count days the same way.
 */
export function leagueDay(days: number, timeZone: string, now: Date = new Date()): string {
  return addDays(todayIn(timeZone, now), days);
}
