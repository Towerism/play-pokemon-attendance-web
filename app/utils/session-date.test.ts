import { describe, expect, it } from 'vitest';
import { localDate, sessionDateFromQuery } from './session-date';

describe('localDate', () => {
  it('formats the local calendar date, not the UTC one', () => {
    // 23:30 local on Oct 14 is already Oct 15 in UTC for anyone west of UTC.
    expect(localDate(new Date(2026, 9, 14, 23, 30))).toBe('2026-10-14');
    expect(localDate(new Date(2026, 0, 5, 0, 5))).toBe('2026-01-05');
  });
});

describe('sessionDateFromQuery', () => {
  const now = new Date(2026, 9, 14, 18, 0);

  it('uses a valid ?date=', () => {
    expect(sessionDateFromQuery('2026-10-07', now)).toBe('2026-10-07');
  });

  it.each([undefined, '', 'yesterday', '2026-02-30', ['2026-10-07']])('falls back to today for %j', (q) => {
    expect(sessionDateFromQuery(q, now)).toBe('2026-10-14');
  });
});
