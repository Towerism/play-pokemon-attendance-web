import { describe, expect, it } from 'vitest';
import type { SessionDate } from '../types/ids';
import { dateIn, localDay } from './local-time';

const day = (s: string) => s as SessionDate;

describe('localDay', () => {
  it('is midnight to midnight in the league timezone, as UTC instants', () => {
    expect(localDay(day('2026-10-13'), 'America/Chicago')).toEqual({
      from: new Date('2026-10-13T05:00:00Z'),
      to: new Date('2026-10-14T05:00:00Z'),
    });
  });

  it('keeps a Tuesday 6 PM Central session on Tuesday after DST ends, though it starts on Wednesday in UTC (S3)', () => {
    const { from, to } = localDay(day('2026-11-10'), 'America/Chicago');
    const start = new Date('2026-11-11T00:00:00Z');
    expect(start >= from && start < to).toBe(true);
  });

  it('is 25 hours on the day DST ends and 23 on the day it starts', () => {
    const hours = (d: string) => {
      const { from, to } = localDay(day(d), 'America/Chicago');
      return (to.getTime() - from.getTime()) / 3_600_000;
    };
    expect(hours('2026-11-01')).toBe(25);
    expect(hours('2026-03-08')).toBe(23);
    expect(localDay(day('2026-11-01'), 'America/Chicago').from).toEqual(new Date('2026-11-01T05:00:00Z'));
  });

  it.each([
    ['UTC', '2026-10-13T00:00:00Z'],
    ['Asia/Kolkata', '2026-10-12T18:30:00Z'],
    ['Pacific/Auckland', '2026-10-12T11:00:00Z'],
  ])('handles %s', (tz, from) => {
    expect(localDay(day('2026-10-13'), tz).from).toEqual(new Date(from));
  });
});

describe('dateIn', () => {
  it('is the calendar date on the league wall clock, not in UTC', () => {
    // 9 PM Tuesday in Chicago is already Wednesday in UTC.
    expect(dateIn(new Date('2026-10-14T02:00:00Z'), 'America/Chicago')).toBe('2026-10-13');
    expect(dateIn(new Date('2026-10-14T05:00:00Z'), 'America/Chicago')).toBe('2026-10-14');
    expect(dateIn(new Date('2026-10-14T02:00:00Z'), 'UTC')).toBe('2026-10-14');
  });
});
