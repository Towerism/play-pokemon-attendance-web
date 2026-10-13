import { afterEach, describe, expect, it } from 'vitest';
import { expandSchedule, occurrenceDates, type ExpandableSchedule, type ScheduleSlot } from './expand';
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

describe('expandSchedule', () => {
  const slot = (position: number, dayOffset: number, startTime: string): ScheduleSlot => ({ position, dayOffset, startTime });
  const schedule = (overrides: Partial<ExpandableSchedule> = {}): ExpandableSchedule => ({
    rule: { kind: 'monthly', nth: 3, weekday: TUESDAY },
    startsOn: '2026-01-01',
    slots: [slot(0, 0, '18:00')],
    timeZone: 'America/Chicago',
    ...overrides,
  });

  it('gives every slot of a back-to-back set for each date, in order, with its instant at the venue', () => {
    const slots = [slot(2, 1, '10:00'), slot(1, 0, '16:00'), slot(0, 0, '12:00')];
    expect(expandSchedule(schedule({ slots }), { from: '2026-10-01', to: '2026-11-30' })).toEqual([
      { occurrenceDate: '2026-10-20', slotPosition: 0, localDate: '2026-10-20', startTime: '12:00', startsAt: new Date('2026-10-20T17:00:00Z') },
      { occurrenceDate: '2026-10-20', slotPosition: 1, localDate: '2026-10-20', startTime: '16:00', startsAt: new Date('2026-10-20T21:00:00Z') },
      { occurrenceDate: '2026-10-20', slotPosition: 2, localDate: '2026-10-21', startTime: '10:00', startsAt: new Date('2026-10-21T15:00:00Z') },
      { occurrenceDate: '2026-11-17', slotPosition: 0, localDate: '2026-11-17', startTime: '12:00', startsAt: new Date('2026-11-17T18:00:00Z') },
      { occurrenceDate: '2026-11-17', slotPosition: 1, localDate: '2026-11-17', startTime: '16:00', startsAt: new Date('2026-11-17T22:00:00Z') },
      { occurrenceDate: '2026-11-17', slotPosition: 2, localDate: '2026-11-18', startTime: '10:00', startsAt: new Date('2026-11-18T16:00:00Z') },
    ]);
  });

  it('orders two slots on the same day by start time, then position', () => {
    const slots = [slot(0, 0, '16:00'), slot(1, 0, '12:00'), slot(2, 0, '12:00')];
    const [a, b, c] = expandSchedule(schedule({ slots }), { from: '2026-10-01', to: '2026-10-31' });
    expect([a!.slotPosition, b!.slotPosition, c!.slotPosition]).toEqual([1, 2, 0]);
  });

  it('carries a slot across a year end and onto a leap day', () => {
    const yearEnd = expandSchedule(schedule({ rule: { kind: 'monthly', day: 31 }, slots: [slot(0, 1, '10:00')] }), {
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(yearEnd.map((o) => [o.occurrenceDate, o.localDate])).toEqual([['2026-12-31', '2027-01-01']]);
    const leap = expandSchedule(schedule({ rule: { kind: 'monthly', day: 28 }, slots: [slot(0, 1, '10:00')] }), {
      from: '2028-02-01',
      to: '2028-02-28',
    });
    expect(leap.map((o) => o.localDate)).toEqual(['2028-02-29']);
  });

  it('filters on the scaffold date, so a Saturday + Sunday set is never split by the range', () => {
    const weekend = schedule({ rule: { kind: 'weekly', weekday: 6, every: 1 }, slots: [slot(0, 0, '12:00'), slot(1, 1, '12:00')] });
    // 2026-10-17 is a Saturday.
    expect(expandSchedule(weekend, { from: '2026-10-11', to: '2026-10-17' }).map((o) => o.localDate)).toEqual(['2026-10-17', '2026-10-18']);
    expect(expandSchedule(weekend, { from: '2026-10-18', to: '2026-10-23' })).toEqual([]);
  });

  it('marks only the date whose start a DST change skips, and plans the rest', () => {
    const sundays = schedule({ rule: { kind: 'weekly', weekday: 7, every: 1 }, slots: [slot(0, 0, '02:30')] });
    const march = expandSchedule(sundays, { from: '2026-03-01', to: '2026-03-31' });
    expect(march.map((o) => [o.localDate, o.startsAt?.toISOString() ?? null, o.timeProblem])).toEqual([
      ['2026-03-01', '2026-03-01T08:30:00.000Z', undefined],
      ['2026-03-08', null, 'nonexistent'],
      ['2026-03-15', '2026-03-15T07:30:00.000Z', undefined],
      ['2026-03-22', '2026-03-22T07:30:00.000Z', undefined],
      ['2026-03-29', '2026-03-29T07:30:00.000Z', undefined],
    ]);
    expect(march.filter((o) => o.startsAt).every((o) => !('timeProblem' in o))).toBe(true);
  });

  it('marks a start a DST change repeats as ambiguous', () => {
    const sundays = schedule({ rule: { kind: 'weekly', weekday: 7, every: 1 }, slots: [slot(0, 0, '01:30')] });
    const [first] = expandSchedule(sundays, { from: '2026-11-01', to: '2026-11-01' });
    expect(first).toMatchObject({ localDate: '2026-11-01', startsAt: null, timeProblem: 'ambiguous' });
  });

  it('is empty for a scaffold with no slots', () => {
    expect(expandSchedule(schedule({ slots: [] }), { from: '2026-10-01', to: '2026-12-31' })).toEqual([]);
  });

  it.each([
    [{ slots: [slot(0, 7, '18:00')] }, /offset/],
    [{ slots: [slot(0, -1, '18:00')] }, /offset/],
    [{ slots: [slot(0, 1.5, '18:00')] }, /offset/],
    [{ slots: [slot(0, 0, '18:00'), slot(0, 1, '18:00')] }, /position 0/],
    [{ slots: [slot(0, 0, '24:00')] }, /24:00/],
    [{ timeZone: 'Mars/Olympus' }, /Mars\/Olympus/],
  ])('refuses %j', (overrides, named) => {
    expect(() => expandSchedule(schedule(overrides), { from: '2026-10-01', to: '2026-12-31' })).toThrow(RangeError);
    expect(() => expandSchedule(schedule(overrides), { from: '2026-10-01', to: '2026-12-31' })).toThrow(named);
  });
});

describe("the host's time zone", () => {
  const hostTz = process.env.TZ;
  afterEach(() => {
    if (hostTz === undefined) delete process.env.TZ;
    else process.env.TZ = hostTz;
  });

  const run = () => [
    occurrenceDates({ kind: 'monthly', nth: 3, weekday: TUESDAY }, { startsOn: '2026-01-01' }, { from: '2026-10-01', to: '2026-12-31' }),
    expandSchedule(
      {
        rule: { kind: 'weekly', weekday: 7, every: 1 },
        startsOn: '2026-01-01',
        slots: [
          { position: 0, dayOffset: 0, startTime: '02:30' },
          { position: 1, dayOffset: 6, startTime: '23:30' },
        ],
        timeZone: 'America/Chicago',
      },
      { from: '2026-02-20', to: '2026-03-31' },
    ),
  ];

  it('never changes a result', () => {
    process.env.TZ = 'UTC';
    const expected = run();
    for (const tz of ['Pacific/Kiritimati', 'America/Adak']) {
      process.env.TZ = tz;
      expect(new Date(Date.UTC(2026, 2, 8, 12)).getHours()).not.toBe(12); // the host zone really changed
      expect(run()).toEqual(expected);
    }
  });
});

describe('occurrenceDates, invalid input', () => {
  const rule: ScheduleRule = { kind: 'weekly', weekday: TUESDAY, every: 1 };
  const bounds = { startsOn: '2026-10-01' };
  const range = { from: '2026-10-01', to: '2026-12-31' };

  it.each([
    [{ kind: 'weekly', weekday: TUESDAY, every: 5 }, /rule/],
    [{ kind: 'monthly', nth: 5, weekday: TUESDAY }, /rule/],
    [{ kind: 'monthly', day: 32 }, /rule/],
    [{ kind: 'quarterly', month: 4, nth: 1, weekday: 6 }, /rule/],
  ])('refuses the rule %j', (bad, named) => {
    expect(() => occurrenceDates(bad as ScheduleRule, bounds, range)).toThrow(RangeError);
    expect(() => occurrenceDates(bad as ScheduleRule, bounds, range)).toThrow(named);
  });

  it.each([
    [{ startsOn: '2026-02-30' }, range, /2026-02-30/],
    [{ startsOn: '2026-10-01', endsOn: '2026-13-01' }, range, /2026-13-01/],
    [bounds, { from: '2026-1-5', to: '2026-12-31' }, /2026-1-5/],
    [bounds, { from: '2026-10-01', to: 'tomorrow' }, /tomorrow/],
  ])('refuses a malformed date (%j, %j)', (b, r, named) => {
    expect(() => occurrenceDates(rule, b, r)).toThrow(RangeError);
    expect(() => occurrenceDates(rule, b, r)).toThrow(named);
  });

  it('refuses a range longer than 400 days, and takes one of exactly 400', () => {
    expect(() => occurrenceDates(rule, bounds, { from: '2026-10-01', to: '2027-11-05' })).toThrow(/400 days/);
    expect(occurrenceDates(rule, bounds, { from: '2026-10-01', to: '2027-11-04' })).toHaveLength(57);
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
