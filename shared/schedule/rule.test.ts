import { describe, expect, it } from 'vitest';
import { scheduleRuleSchema } from './rule';

describe('scheduleRuleSchema', () => {
  it.each([
    { kind: 'weekly', weekday: 2, every: 1 },
    { kind: 'weekly', weekday: 7, every: 4 },
    { kind: 'monthly', nth: 3, weekday: 2 },
    { kind: 'monthly', nth: 'last', weekday: 5 },
    { kind: 'monthly', day: 1 },
    { kind: 'monthly', day: 31 },
    { kind: 'quarterly', month: 1, nth: 2, weekday: 6 },
    { kind: 'quarterly', month: 3, nth: 'last', weekday: 7 },
  ])('accepts %j as stored', (rule) => {
    expect(scheduleRuleSchema.parse(rule)).toEqual(rule);
  });

  it.each([
    { kind: 'daily' },
    { kind: 'weekly', weekday: 2, every: 5 },
    { kind: 'weekly', weekday: 2, every: 0 },
    { kind: 'weekly', weekday: 0, every: 1 },
    { kind: 'weekly', weekday: 8, every: 1 },
    { kind: 'weekly', weekday: 2.5, every: 1 },
    { kind: 'weekly', weekday: '2', every: 1 },
    { kind: 'weekly', weekday: 2 },
    { kind: 'monthly', nth: 5, weekday: 2 },
    { kind: 'monthly', nth: 0, weekday: 2 },
    { kind: 'monthly', nth: 'first', weekday: 2 },
    { kind: 'monthly', day: 0 },
    { kind: 'monthly', day: 32 },
    { kind: 'monthly', day: 31, nth: 1, weekday: 2 },
    { kind: 'monthly', day: 31, weekday: 2 },
    { kind: 'monthly' },
    { kind: 'quarterly', month: 4, nth: 1, weekday: 6 },
    { kind: 'quarterly', month: 0, nth: 1, weekday: 6 },
    { kind: 'quarterly', month: 1, day: 15 },
    { kind: 'weekly', weekday: 2, every: 1, extra: true },
  ])('refuses %j', (rule) => {
    expect(scheduleRuleSchema.safeParse(rule).success).toBe(false);
  });
});
