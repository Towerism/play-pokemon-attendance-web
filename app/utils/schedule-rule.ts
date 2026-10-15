import type { Nth, ScheduleRule, Weekday } from '../../shared/schedule/rule';

/** ISO weekdays, 1 = Monday … 7 = Sunday, as the schedule rule stores them. */
export const WEEKDAY_NAMES: Record<Weekday, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

const ORDINAL: Record<1 | 2 | 3 | 4, string> = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };

/** "2nd" or "Last": capitalised only at the start of the sentence. */
const nthText = (nth: Nth) => (nth === 'last' ? 'Last' : ORDINAL[nth]);

/** The schedule form's recurrence fields: every field kept, so switching the kind loses nothing typed. */
export interface RuleParts {
  kind: 'weekly' | 'monthly_nth' | 'monthly_day' | 'quarterly';
  weekday: Weekday;
  every: 1 | 2 | 3 | 4;
  nth: Nth;
  day: number;
  month: 1 | 2 | 3;
}

export function ruleFromParts(p: RuleParts): ScheduleRule {
  switch (p.kind) {
    case 'weekly':
      return { kind: 'weekly', weekday: p.weekday, every: p.every };
    case 'monthly_nth':
      return { kind: 'monthly', nth: p.nth, weekday: p.weekday };
    case 'monthly_day':
      return { kind: 'monthly', day: p.day };
    case 'quarterly':
      return { kind: 'quarterly', month: p.month, nth: p.nth, weekday: p.weekday };
  }
}

export function partsFromRule(rule: ScheduleRule): RuleParts {
  const parts: RuleParts = { kind: 'weekly', weekday: 1, every: 1, nth: 1, day: 1, month: 1 };
  if (rule.kind === 'weekly') return { ...parts, weekday: rule.weekday, every: rule.every };
  if (rule.kind === 'quarterly') return { ...parts, kind: 'quarterly', month: rule.month, nth: rule.nth, weekday: rule.weekday };
  return 'day' in rule ? { ...parts, kind: 'monthly_day', day: rule.day } : { ...parts, kind: 'monthly_nth', nth: rule.nth, weekday: rule.weekday };
}

/** A schedule's recurrence in words (ADR-0010 decision 3), e.g. "2nd Saturday of each month". */
export function ruleText(rule: ScheduleRule): string {
  switch (rule.kind) {
    case 'weekly':
      return rule.every === 1 ? `Every ${WEEKDAY_NAMES[rule.weekday]}` : `Every ${rule.every} weeks on ${WEEKDAY_NAMES[rule.weekday]}`;
    case 'monthly':
      return 'day' in rule ? `Day ${rule.day} of each month` : `${nthText(rule.nth)} ${WEEKDAY_NAMES[rule.weekday]} of each month`;
    case 'quarterly':
      return `${nthText(rule.nth)} ${WEEKDAY_NAMES[rule.weekday]} of the ${ORDINAL[rule.month]} month of each quarter`;
  }
}
