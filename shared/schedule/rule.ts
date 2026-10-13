import { z } from '../zod';

/** ISO 8601 weekday: 1 = Monday … 7 = Sunday. */
const weekday = z.literal([1, 2, 3, 4, 5, 6, 7]);
/** Which of a weekday in the month: 1st–4th, or the last (a month can have five). */
const nth = z.union([z.literal([1, 2, 3, 4]), z.literal('last')]);

/**
 * A schedule's recurrence (ADR-0010 decision 3), stored as
 * `TOURNAMENT_SCHEDULE.rule`. A deliberately small set, not RFC 5545.
 */
export const scheduleRuleSchema = z.union([
  z.strictObject({ kind: z.literal('weekly'), weekday, every: z.literal([1, 2, 3, 4]) }),
  z.strictObject({ kind: z.literal('monthly'), nth, weekday }),
  // A month shorter than `day` uses its last day.
  z.strictObject({ kind: z.literal('monthly'), day: z.int().min(1).max(31) }),
  // `month` is the month of each calendar quarter: 1 = Jan/Apr/Jul/Oct.
  z.strictObject({ kind: z.literal('quarterly'), month: z.literal([1, 2, 3]), nth, weekday }),
]);

export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;
export type Weekday = z.infer<typeof weekday>;
export type Nth = z.infer<typeof nth>;
