import { describe, expect, it } from 'vitest';
import type { ScheduleRule } from '../../shared/schedule/rule';
import { type RuleParts, partsFromRule, ruleFromParts, ruleText } from './schedule-rule';

describe('the schedule form’s recurrence', () => {
  const base: RuleParts = { kind: 'weekly', weekday: 2, every: 1, nth: 1, day: 1, month: 1 };

  it.each([
    [{ ...base }, { kind: 'weekly', weekday: 2, every: 1 }],
    [{ ...base, kind: 'monthly_nth', nth: 'last', weekday: 7 }, { kind: 'monthly', nth: 'last', weekday: 7 }],
    [{ ...base, kind: 'monthly_day', day: 15 }, { kind: 'monthly', day: 15 }],
    [{ ...base, kind: 'quarterly', month: 2, nth: 1, weekday: 6 }, { kind: 'quarterly', month: 2, nth: 1, weekday: 6 }],
  ] as [RuleParts, ScheduleRule][])('builds %j', (parts, rule) => {
    expect(ruleFromParts(parts)).toEqual(rule);
    expect(ruleFromParts(partsFromRule(rule))).toEqual(rule);
  });
});

describe('ruleText', () => {
  it.each([
    [{ kind: 'weekly', weekday: 2, every: 1 }, 'Every Tuesday'],
    [{ kind: 'weekly', weekday: 2, every: 2 }, 'Every 2 weeks on Tuesday'],
    [{ kind: 'weekly', weekday: 7, every: 4 }, 'Every 4 weeks on Sunday'],
    [{ kind: 'monthly', nth: 2, weekday: 6 }, '2nd Saturday of each month'],
    [{ kind: 'monthly', nth: 'last', weekday: 7 }, 'Last Sunday of each month'],
    [{ kind: 'monthly', nth: 3, weekday: 1 }, '3rd Monday of each month'],
    [{ kind: 'monthly', nth: 4, weekday: 5 }, '4th Friday of each month'],
    [{ kind: 'monthly', day: 15 }, 'Day 15 of each month'],
    [{ kind: 'quarterly', month: 2, nth: 1, weekday: 6 }, '1st Saturday of the 2nd month of each quarter'],
    [{ kind: 'quarterly', month: 3, nth: 'last', weekday: 3 }, 'Last Wednesday of the 3rd month of each quarter'],
  ] as [ScheduleRule, string][])('%j → %s', (rule, text) => {
    expect(ruleText(rule)).toBe(text);
  });
});
