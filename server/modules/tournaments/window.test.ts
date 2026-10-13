import { describe, expect, it } from 'vitest';
import { checkCreatable, creatableWindow, sanctionBy } from './window';

const CHICAGO = 'America/Chicago';

describe('the creatable window (today − 2 days to 12 months ahead, league time zone)', () => {
  // 00:30 in Chicago on the day after the 2026 fall-back (CST, UTC − 6).
  const justAfterFallBack = new Date('2026-11-02T06:30:00Z');

  it('runs from two days before today to the same date a year on, by the local date', () => {
    expect(creatableWindow(justAfterFallBack, CHICAGO)).toEqual({ from: '2026-10-31', to: '2027-11-02' });
  });

  it.each([
    ['2026-10-30', 'date_too_far_past'],
    ['2026-10-31', null],
    ['2026-11-02', null],
    ['2027-11-02', null],
    ['2027-11-03', 'date_too_far_ahead'],
  ])('%s → %s', (date, problem) => {
    expect(checkCreatable(date, justAfterFallBack, CHICAGO)).toBe(problem);
  });

  it('uses the league date, not the UTC one, late in the evening', () => {
    // 23:30 on 2026-10-14 in Chicago is already the 15th in UTC.
    const lateEvening = new Date('2026-10-15T04:30:00Z');
    expect(creatableWindow(lateEvening, CHICAGO).from).toBe('2026-10-12');
    expect(checkCreatable('2026-10-12', lateEvening, CHICAGO)).toBeNull();
    expect(checkCreatable('2026-10-11', lateEvening, CHICAGO)).toBe('date_too_far_past');
  });

  it('ends on the last day of February when today is a leap day', () => {
    expect(creatableWindow(new Date('2028-02-29T18:00:00Z'), CHICAGO)).toEqual({ from: '2028-02-27', to: '2029-02-28' });
  });

  it('crosses a month and a year end going back', () => {
    expect(creatableWindow(new Date('2027-01-01T18:00:00Z'), CHICAGO).from).toBe('2026-12-30');
  });
});

describe('sanction by (the date − 7 days)', () => {
  it.each([
    ['2026-10-20', '2026-10-13'],
    ['2026-03-03', '2026-02-24'],
    ['2027-01-05', '2026-12-29'],
  ])('%s → %s', (date, by) => {
    expect(sanctionBy(date)).toBe(by);
  });
});
