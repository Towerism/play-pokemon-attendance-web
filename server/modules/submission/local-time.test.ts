import { describe, expect, it } from 'vitest';
import { sessionLabel, sessionTitle } from './local-time';

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

describe('sessionTitle', () => {
  it('names a session from its type and products, without the weekday and time a calendar event already shows', () => {
    expect(sessionTitle({ type: 'open_play', products: ['tcg', 'vg'] })).toBe('Open play · TCG, VG');
    expect(sessionTitle({ type: 'league_challenge', products: [] })).toBe('League challenge');
  });
});
