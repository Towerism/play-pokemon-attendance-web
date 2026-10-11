import { describe, expect, it } from 'vitest';
import { SettingsBody, Thresholds } from './settings';

describe('SettingsBody', () => {
  it('takes the chosen activity group', () => {
    expect(SettingsBody.parse({ activityGroupId: ' 00000000-0000-4000-8000-000000000004 ' })).toEqual({
      activityGroupId: '00000000-0000-4000-8000-000000000004',
    });
  });

  it.each([
    ['empty', { activityGroupId: '' }],
    ['over 100 characters', { activityGroupId: 'a'.repeat(101) }],
  ])('rejects an activity group id that is %s', (_l, body) => {
    expect(SettingsBody.safeParse(body).success).toBe(false);
  });

  it('takes the curation thresholds', () => {
    expect(SettingsBody.parse({ thresholds: { promoteMinSightings: 3, staleAfterSessions: 8 } })).toEqual({
      thresholds: { promoteMinSightings: 3, staleAfterSessions: 8 },
    });
  });

  it('takes both at once', () => {
    const body = { activityGroupId: 'g', thresholds: { promoteMinSightings: 4, staleAfterSessions: 6 } };
    expect(SettingsBody.parse(body)).toEqual(body);
  });

  it('rejects a body that changes nothing', () => {
    expect(SettingsBody.safeParse({}).success).toBe(false);
  });
});

describe('Thresholds', () => {
  it.each([1, 52])('accepts %i for both', (n) => {
    expect(Thresholds.parse({ promoteMinSightings: n, staleAfterSessions: n })).toEqual({ promoteMinSightings: n, staleAfterSessions: n });
  });

  it.each([
    ['zero', 0],
    ['over a year of sessions', 53],
    ['a fraction', 2.5],
    ['a numeric string', '4'],
    ['null', null],
  ])('rejects %s', (_l, n) => {
    expect(Thresholds.safeParse({ promoteMinSightings: n, staleAfterSessions: 6 }).success).toBe(false);
    expect(Thresholds.safeParse({ promoteMinSightings: 4, staleAfterSessions: n }).success).toBe(false);
  });

  it('needs both', () => {
    expect(Thresholds.safeParse({ promoteMinSightings: 4 }).success).toBe(false);
    expect(Thresholds.safeParse({ staleAfterSessions: 6 }).success).toBe(false);
  });
});
