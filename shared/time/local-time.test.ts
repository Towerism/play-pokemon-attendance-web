import { describe, expect, it } from 'vitest';
import type { SessionDate } from '../types/ids';
import { dateIn, localDay, localInstant, LocalTimeError } from './local-time';

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

describe('localInstant', () => {
  it.each([
    ['2026-10-20', '18:00', 'America/Chicago', '2026-10-20T23:00:00Z'],
    ['2026-11-17', '18:00', 'America/Chicago', '2026-11-18T00:00:00Z'],
    ['2026-10-20', '18:00', 'UTC', '2026-10-20T18:00:00Z'],
    ['2026-10-20', '09:30', 'Asia/Kolkata', '2026-10-20T04:00:00Z'],
    ['2026-01-10', '10:00', 'Australia/Adelaide', '2026-01-09T23:30:00Z'],
    ['2026-07-11', '10:00', 'Australia/Adelaide', '2026-07-11T00:30:00Z'],
    ['2026-10-20', '00:00', 'Pacific/Auckland', '2026-10-19T11:00:00Z'],
  ])('puts %s %s in %s at %s', (date, time, tz, utc) => {
    expect(localInstant(date, time, tz)).toEqual(new Date(utc));
  });

  it('keeps an evening start on its local date though it is the next day in UTC', () => {
    const at = localInstant('2026-11-17', '18:00', 'America/Chicago');
    expect(at.toISOString().slice(0, 10)).toBe('2026-11-18');
    expect(dateIn(at, 'America/Chicago')).toBe('2026-11-17');
  });

  const refusal = (date: string, time: string, tz: string) => {
    try {
      localInstant(date, time, tz);
    } catch (e) {
      return e instanceof LocalTimeError ? e.reason : e;
    }
    return 'accepted';
  };

  it.each([
    ['2026-03-08', '02:30', 'America/Chicago', 'nonexistent'],
    ['2026-03-08', '02:00', 'America/Chicago', 'nonexistent'],
    ['2026-11-01', '01:30', 'America/Chicago', 'ambiguous'],
    ['2026-11-01', '01:00', 'America/Chicago', 'ambiguous'],
    // Chile changes at midnight, so a midnight pre-release there can fall in the gap.
    ['2026-09-06', '00:00', 'America/Santiago', 'nonexistent'],
    ['2026-09-06', '00:30', 'America/Santiago', 'nonexistent'],
    ['2026-04-04', '23:30', 'America/Santiago', 'ambiguous'],
    ['2026-10-04', '02:30', 'Australia/Sydney', 'nonexistent'],
    ['2026-04-05', '02:30', 'Australia/Sydney', 'ambiguous'],
  ])('refuses %s %s in %s as %s, never guessing', (date, time, tz, reason) => {
    expect(refusal(date, time, tz)).toBe(reason);
  });

  it.each([
    ['2026-03-08', '01:59', 'America/Chicago', '2026-03-08T07:59:00Z'],
    ['2026-03-08', '03:00', 'America/Chicago', '2026-03-08T08:00:00Z'],
    ['2026-11-01', '00:59', 'America/Chicago', '2026-11-01T05:59:00Z'],
    ['2026-11-01', '02:00', 'America/Chicago', '2026-11-01T08:00:00Z'],
    ['2026-09-06', '01:00', 'America/Santiago', '2026-09-06T04:00:00Z'],
    ['2026-04-04', '22:59', 'America/Santiago', '2026-04-05T01:59:00Z'],
    ['2026-04-05', '00:00', 'America/Santiago', '2026-04-05T04:00:00Z'],
  ])('accepts %s %s in %s, just outside the change', (date, time, tz, utc) => {
    expect(localInstant(date, time, tz)).toEqual(new Date(utc));
  });

  it.each([
    ['2026-02-30', '18:00', 'UTC', /2026-02-30/],
    ['2026-1-5', '18:00', 'UTC', /2026-1-5/],
    ['2026-10-20', '24:00', 'UTC', /24:00/],
    ['2026-10-20', '9:00', 'UTC', /9:00/],
    ['2026-10-20', '18:60', 'UTC', /18:60/],
    ['2026-10-20', '18:00', 'Mars/Olympus', /Mars\/Olympus/],
  ])('refuses a malformed input (%s %s %s)', (date, time, tz, named) => {
    expect(() => localInstant(date, time, tz)).toThrow(RangeError);
    expect(() => localInstant(date, time, tz)).toThrow(named);
    expect(refusal(date, time, tz)).toBeInstanceOf(RangeError);
  });

  it('is a RangeError naming the time and zone', () => {
    expect(() => localInstant('2026-03-08', '02:30', 'America/Chicago')).toThrow(RangeError);
    expect(() => localInstant('2026-03-08', '02:30', 'America/Chicago')).toThrow(/2026-03-08 02:30.*America\/Chicago/);
  });
});
