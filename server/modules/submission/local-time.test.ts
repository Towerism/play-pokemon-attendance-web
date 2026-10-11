import { describe, expect, it } from 'vitest';
import type { SessionDate } from '../../../shared/types/ids';
import { localDay, sessionLabel } from './local-time';

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

describe('sessionLabel', () => {
  it('names a session from its type, products and local start, since upstream has no title (S3)', () => {
    expect(
      sessionLabel({ type: 'open_play', products: ['tcg', 'vg', 'pgo'], startsAt: new Date('2026-10-13T23:00:00Z') }, 'America/Chicago'),
    ).toBe('Open play · TCG, VG, GO · Tue 6:00 PM');
  });

  it('passes unknown types and products through readably', () => {
    expect(sessionLabel({ type: 'league_challenge', products: ['xyz'], startsAt: new Date('2026-10-13T17:00:00Z') }, 'UTC')).toBe(
      'League challenge · XYZ · Tue 5:00 PM',
    );
  });

  it('leaves out an empty product list', () => {
    expect(sessionLabel({ type: 'open_play', products: [], startsAt: new Date('2026-10-13T17:00:00Z') }, 'UTC')).toBe(
      'Open play · Tue 5:00 PM',
    );
  });
});
