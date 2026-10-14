import { describe, expect, it } from 'vitest';
import { dateIn } from '../time/local-time';
import { addDays, periodOf, periodsFor } from './periods';

describe('periodsFor', () => {
  it('gives a monthly requirement the previous, current and next two calendar months', () => {
    expect(periodsFor('month', '2026-10-14')).toEqual([
      { start: '2026-09-01', end: '2026-09-30' },
      { start: '2026-10-01', end: '2026-10-31' },
      { start: '2026-11-01', end: '2026-11-30' },
      { start: '2026-12-01', end: '2026-12-31' },
    ]);
  });

  it('gives a quarterly requirement the previous, current and next calendar quarters, across a year end', () => {
    expect(periodsFor('quarter', '2026-10-14')).toEqual([
      { start: '2026-07-01', end: '2026-09-30' },
      { start: '2026-10-01', end: '2026-12-31' },
      { start: '2027-01-01', end: '2027-03-31' },
    ]);
  });

  it('takes the previous quarter back across a year start', () => {
    expect(periodsFor('quarter', '2027-01-01')[0]).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(periodsFor('month', '2027-01-01')[0]).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });

  it('ends February on its last day in leap and common years', () => {
    expect(periodsFor('month', '2028-02-10')[1]).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(periodsFor('month', '2027-02-10')[1]).toEqual({ start: '2027-02-01', end: '2027-02-28' });
  });

  it('puts the first and last days of a period in that period', () => {
    expect(periodsFor('month', '2026-10-01')[1]!.start).toBe('2026-10-01');
    expect(periodsFor('month', '2026-10-31')[1]!.start).toBe('2026-10-01');
    expect(periodsFor('quarter', '2026-12-31')[1]!.start).toBe('2026-10-01');
  });

  it("takes today on the league's wall clock, so the night DST ends is still October in Chicago", () => {
    const today = dateIn(new Date('2026-11-01T03:30:00Z'), 'America/Chicago');
    expect(periodsFor('month', today)[1]!.start).toBe('2026-10-01');
  });

  it('keeps the spring-forward night in its own day', () => {
    expect(dateIn(new Date('2027-03-14T08:30:00Z'), 'America/Chicago')).toBe('2027-03-14');
    expect(periodsFor('quarter', '2027-03-14')[1]).toEqual({ start: '2027-01-01', end: '2027-03-31' });
  });
});

describe('periodOf', () => {
  it('accepts only the first day of a period of the cadence', () => {
    expect(periodOf('month', '2026-11-01')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(periodOf('quarter', '2026-10-01')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(periodOf('quarter', '2026-11-01')).toBeNull();
    expect(periodOf('month', '2026-11-02')).toBeNull();
    expect(periodOf('month', '2026-02-30')).toBeNull();
  });
});

describe('addDays', () => {
  it('moves across month and year ends', () => {
    expect(addDays('2026-11-30', 2)).toBe('2026-12-02');
    expect(addDays('2027-01-02', -3)).toBe('2026-12-30');
  });
});
