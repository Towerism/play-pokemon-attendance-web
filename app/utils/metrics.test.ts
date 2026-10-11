import { describe, expect, it } from 'vitest';
import { absenceLabel, lastSeenLabel, ratePercent } from './metrics';

describe('ratePercent', () => {
  it.each([
    [1, '100%'],
    [2 / 3, '67%'],
    [0, '0%'],
    [null, '—'],
  ])('%s → %s', (rate, label) => {
    expect(ratePercent(rate)).toBe(label);
  });
});

describe('lastSeenLabel', () => {
  it('says never for a player with no sightings', () => {
    expect(lastSeenLabel(null)).toBe('Never');
  });

  it.each([
    [0, 'Latest session'],
    [1, '1 session ago'],
    [5, '5 sessions ago'],
  ])('counts league sessions, not days (%i)', (n, label) => {
    expect(lastSeenLabel({ sessionsSinceLastSeen: n })).toBe(label);
  });
});

describe('absenceLabel', () => {
  it.each([
    [null, 'No tdf or manual sighting yet'],
    [{ sessionsSinceLastPresent: null }, 'No tdf or manual sighting yet'],
    [{ sessionsSinceLastPresent: 1 }, 'Not present for 1 session'],
    [{ sessionsSinceLastPresent: 7 }, 'Not present for 7 sessions'],
  ])('%j → %s', (metrics, label) => {
    expect(absenceLabel(metrics)).toBe(label);
  });
});
