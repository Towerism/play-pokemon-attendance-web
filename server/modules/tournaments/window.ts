import { dateIn } from '../../../shared/time/local-time';
import { addDays, addMonths, type LocalDate } from './dates';

export type WindowProblem = 'date_too_far_past' | 'date_too_far_ahead';

/** How far back a tournament may still be created (ADR-0010 decision 6: held in the last 2 days). */
export const BACK_DATING_DAYS = 2;

/**
 * The dates a tournament may be created, edited or planned on, both ends inclusive: from today − 2 days to
 * the same date 12 months on, by the local date in the league time zone (ADR-0010 decision 6).
 */
export function creatableWindow(now: Date, timeZone: string): { from: LocalDate; to: LocalDate } {
  const today = dateIn(now, timeZone);
  return { from: addDays(today, -BACK_DATING_DAYS), to: addMonths(today, 12) };
}

/** Null when `date` is in the creatable window; otherwise which end it is past. */
export function checkCreatable(date: LocalDate, now: Date, timeZone: string): WindowProblem | null {
  const window = creatableWindow(now, timeZone);
  if (date < window.from) return 'date_too_far_past';
  if (date > window.to) return 'date_too_far_ahead';
  return null;
}

/** The league is expected to sanction a tournament 7 days before it is held (a guideline, ADR-0010 decision 6). */
export function sanctionBy(date: LocalDate): LocalDate {
  return addDays(date, -7);
}
