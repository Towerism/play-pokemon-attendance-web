import { describe, expect, it } from 'vitest';
import { occurrenceDates } from './expand';
import type { ScheduleRule } from './rule';

const TUESDAY = 2;

/** Every rule the schema accepts: 28 weekly, 35 + 31 monthly, 105 quarterly. */
const ALL_RULES: ScheduleRule[] = (() => {
  const weekdays = [1, 2, 3, 4, 5, 6, 7] as const;
  const nths = [1, 2, 3, 4, 'last'] as const;
  return [
    ...weekdays.flatMap((weekday) => ([1, 2, 3, 4] as const).map((every) => ({ kind: 'weekly', weekday, every }) as const)),
    ...weekdays.flatMap((weekday) => nths.map((nth) => ({ kind: 'monthly', nth, weekday }) as const)),
    ...Array.from({ length: 31 }, (_, i) => ({ kind: 'monthly', day: i + 1 }) as const),
    ...([1, 2, 3] as const).flatMap((month) => weekdays.flatMap((weekday) => nths.map((nth) => ({ kind: 'quarterly', month, nth, weekday }) as const))),
  ];
})();

/**
 * An independent oracle: does `date` belong to `rule`? Brute force over the
 * calendar with Date's own weekday and month length, sharing nothing with the
 * engine's arithmetic.
 */
function belongs(rule: ScheduleRule, date: Date, startsOn: Date): boolean {
  const weekday = date.getUTCDay() || 7;
  const dom = date.getUTCDate();
  const length = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const nthMatches = (nth: number | 'last') => (nth === 'last' ? dom + 7 > length : Math.ceil(dom / 7) === nth);
  if (date < startsOn) return false;
  switch (rule.kind) {
    case 'weekly': {
      const weeks = (date.getTime() - startsOn.getTime()) / (7 * 86_400_000);
      // The first matching weekday on or after startsOn sets the phase.
      const firstOffset = ((rule.weekday - (startsOn.getUTCDay() || 7) + 7) % 7) / 7;
      return weekday === rule.weekday && Math.round(weeks - firstOffset) % rule.every === 0;
    }
    case 'monthly':
      return 'day' in rule ? dom === Math.min(rule.day, length) : weekday === rule.weekday && nthMatches(rule.nth);
    case 'quarterly':
      return date.getUTCMonth() % 3 === rule.month - 1 && weekday === rule.weekday && nthMatches(rule.nth);
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

describe('occurrenceDates, every rule over 2024–2031', () => {
  const startsOn = '2024-01-03'; // a Wednesday, so weekly phases don't start on the 1st
  const years = [2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031];

  it.each(ALL_RULES.map((rule) => [JSON.stringify(rule), rule] as const))('%s matches the brute-force calendar', (_, rule) => {
    const expected: string[] = [];
    for (let t = Date.UTC(2024, 0, 1); t <= Date.UTC(2031, 11, 31); t += 86_400_000) {
      if (belongs(rule, new Date(t), new Date(`${startsOn}T00:00:00Z`))) expected.push(iso(new Date(t)));
    }

    // Expanded a year at a time, and a month at a time: splitting the range never changes the answer.
    const byYear = years.flatMap((y) => occurrenceDates(rule, { startsOn }, { from: `${y}-01-01`, to: `${y}-12-31` }));
    const byMonth = years.flatMap((y) =>
      Array.from({ length: 12 }, (_, m) =>
        occurrenceDates(rule, { startsOn }, { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) }),
      ).flat(),
    );

    expect(byYear).toEqual(expected);
    expect(byMonth).toEqual(expected);
    expect(new Set(byYear).size).toBe(byYear.length);
    // One date per month (or quarter), and none missing once the schedule has started (January 2024 may be).
    const periods = (per: (month: number) => number) => byYear.map((d) => `${d.slice(0, 4)}-${per(Number(d.slice(5, 7)))}`);
    if (rule.kind === 'monthly') {
      expect(new Set(periods((m) => m)).size).toBe(byYear.length);
      expect(byYear.filter((d) => d >= '2024-02-01')).toHaveLength(8 * 12 - 1);
    }
    if (rule.kind === 'quarterly') {
      expect(new Set(periods((m) => Math.ceil(m / 3))).size).toBe(byYear.length);
      expect(byYear.filter((d) => d >= '2024-04-01')).toHaveLength(8 * 4 - 1);
    }
    if (rule.kind === 'weekly') {
      const gaps = byYear.slice(1).map((d, i) => (Date.parse(d) - Date.parse(byYear[i]!)) / 86_400_000);
      expect(new Set(gaps)).toEqual(new Set([rule.every * 7]));
    }
  });
});

describe('occurrenceDates, weekly', () => {
  const weekly = (every: 1 | 2 | 3 | 4 = 1): ScheduleRule => ({ kind: 'weekly', weekday: TUESDAY, every });

  it('is every Tuesday in the range', () => {
    expect(occurrenceDates(weekly(), { startsOn: '2026-10-01' }, { from: '2026-10-01', to: '2026-10-31' })).toEqual([
      '2026-10-06',
      '2026-10-13',
      '2026-10-20',
      '2026-10-27',
    ]);
  });

  it('keeps the every-2-weeks phase from the first date, not from where the range starts', () => {
    expect(occurrenceDates(weekly(2), { startsOn: '2026-10-06' }, { from: '2026-10-13', to: '2026-11-30' })).toEqual([
      '2026-10-20',
      '2026-11-03',
      '2026-11-17',
    ]);
  });

  it('starts on the first date when it is the weekday, and both bounds are inclusive', () => {
    expect(
      occurrenceDates(weekly(), { startsOn: '2026-10-13', endsOn: '2026-10-27' }, { from: '2026-09-01', to: '2026-12-31' }),
    ).toEqual(['2026-10-13', '2026-10-20', '2026-10-27']);
  });

  it('is empty when the schedule and the range do not meet (bounds disjoint, endsOn before startsOn, from after to)', () => {
    expect(occurrenceDates(weekly(), { startsOn: '2027-01-01' }, { from: '2026-10-01', to: '2026-12-31' })).toEqual([]);
    expect(occurrenceDates(weekly(), { startsOn: '2026-01-01', endsOn: '2026-09-30' }, { from: '2026-10-01', to: '2026-12-31' })).toEqual([]);
    expect(occurrenceDates(weekly(), { startsOn: '2026-10-01', endsOn: '2026-09-01' }, { from: '2026-10-01', to: '2026-12-31' })).toEqual([]);
    expect(occurrenceDates(weekly(), { startsOn: '2026-10-01' }, { from: '2026-10-31', to: '2026-10-01' })).toEqual([]);
  });
});

describe('occurrenceDates, monthly', () => {
  const always = { startsOn: '2020-01-01' };

  it('is the 3rd Tuesday of each month (the create-through example)', () => {
    const rule: ScheduleRule = { kind: 'monthly', nth: 3, weekday: TUESDAY };
    expect(occurrenceDates(rule, always, { from: '2026-10-01', to: '2026-12-31' })).toEqual(['2026-10-20', '2026-11-17', '2026-12-15']);
  });

  it('tells the 4th from the last in a month with five of the weekday, and not in one with four', () => {
    const fourth: ScheduleRule = { kind: 'monthly', nth: 4, weekday: TUESDAY };
    const last: ScheduleRule = { kind: 'monthly', nth: 'last', weekday: TUESDAY };
    // September 2026 has Tuesdays 1, 8, 15, 22 and 29; October has 6, 13, 20 and 27.
    expect(occurrenceDates(fourth, always, { from: '2026-09-01', to: '2026-10-31' })).toEqual(['2026-09-22', '2026-10-27']);
    expect(occurrenceDates(last, always, { from: '2026-09-01', to: '2026-10-31' })).toEqual(['2026-09-29', '2026-10-27']);
  });

  it('uses the last day of a month shorter than the day asked for', () => {
    const rule: ScheduleRule = { kind: 'monthly', day: 31 };
    expect(occurrenceDates(rule, always, { from: '2027-01-01', to: '2027-04-30' })).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ]);
  });

  it('is 29 February in a leap year and 28 February otherwise', () => {
    const rule: ScheduleRule = { kind: 'monthly', day: 29 };
    expect(occurrenceDates(rule, always, { from: '2028-02-01', to: '2028-02-29' })).toEqual(['2028-02-29']);
    expect(occurrenceDates(rule, always, { from: '2027-02-01', to: '2027-02-28' })).toEqual(['2027-02-28']);
    expect(occurrenceDates({ kind: 'monthly', day: 15 }, always, { from: '2027-02-01', to: '2027-02-28' })).toEqual(['2027-02-15']);
  });

  it('is the 2nd Saturday of the first month of each calendar quarter, across a year end', () => {
    const rule: ScheduleRule = { kind: 'quarterly', month: 1, nth: 2, weekday: 6 };
    expect(occurrenceDates(rule, always, { from: '2026-10-01', to: '2027-07-31' })).toEqual([
      '2026-10-10',
      '2027-01-09',
      '2027-04-10',
      '2027-07-10',
    ]);
  });

  it('is the last Sunday of the third month of each quarter', () => {
    const rule: ScheduleRule = { kind: 'quarterly', month: 3, nth: 'last', weekday: 7 };
    expect(occurrenceDates(rule, always, { from: '2026-10-01', to: '2027-09-30' })).toEqual([
      '2026-12-27',
      '2027-03-28',
      '2027-06-27',
      '2027-09-26',
    ]);
  });

  it('drops a month whose occurrence falls outside the range or the bounds', () => {
    const rule: ScheduleRule = { kind: 'monthly', nth: 3, weekday: TUESDAY };
    expect(occurrenceDates(rule, { startsOn: '2026-10-21' }, { from: '2026-10-01', to: '2026-11-16' })).toEqual([]);
    expect(occurrenceDates(rule, always, { from: '2026-10-20', to: '2026-11-17' })).toEqual(['2026-10-20', '2026-11-17']);
  });
});
