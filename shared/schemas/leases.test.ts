import { describe, expect, it } from 'vitest';
import { GrantLeasesBody, LeaseIdParam } from './leases';

const guid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('GrantLeasesBody', () => {
  it('takes 1–20 distinct tournament guids, lower-cased, a lent user and an optional end', () => {
    expect(GrantLeasesBody.parse({ tournamentIds: [guid(1).toUpperCase()], lesseeUserId: 2 })).toEqual({ tournamentIds: [guid(1)], lesseeUserId: 2 });
    const twenty = Array.from({ length: 20 }, (_, i) => guid(i + 1));
    expect(GrantLeasesBody.parse({ tournamentIds: twenty, lesseeUserId: 2, endsAt: '2026-11-15T06:00:00.000Z' })).toMatchObject({
      endsAt: '2026-11-15T06:00:00.000Z',
    });
    expect(GrantLeasesBody.parse({ tournamentIds: [guid(1)], lesseeUserId: 2, endsAt: '2026-11-15T00:00:00-06:00' }).endsAt).toBe('2026-11-15T00:00:00-06:00');
  });

  it.each([
    [{}],
    [{ tournamentIds: [], lesseeUserId: 2 }],
    [{ tournamentIds: Array.from({ length: 21 }, (_, i) => guid(i + 1)), lesseeUserId: 2 }],
    [{ tournamentIds: [guid(1), guid(1).toUpperCase()], lesseeUserId: 2 }],
    [{ tournamentIds: ['not-a-guid'], lesseeUserId: 2 }],
    [{ tournamentIds: [guid(1)], lesseeUserId: 0 }],
    [{ tournamentIds: [guid(1)], lesseeUserId: -1 }],
    [{ tournamentIds: [guid(1)], lesseeUserId: '3' }],
    [{ tournamentIds: [guid(1)], lesseeUserId: 1.5 }],
    [{ tournamentIds: [guid(1)], lesseeUserId: null }],
    [{ tournamentIds: [guid(1)], lesseeUserId: 2, endsAt: 'tomorrow' }],
    [{ tournamentIds: [guid(1)], lesseeUserId: 2, endsAt: '2026-11-15' }],
    [{ tournamentIds: [guid(1)], lesseeUserId: 2, extra: true }],
  ])('refuses %j', (body) => {
    expect(GrantLeasesBody.safeParse(body).success).toBe(false);
  });
});

describe('LeaseIdParam', () => {
  it('takes a positive id', () => {
    expect(LeaseIdParam.parse({ id: '7' })).toEqual({ id: 7 });
  });

  it.each(['0', 'abc', '12345678901234567'])('refuses %s', (id) => {
    expect(LeaseIdParam.safeParse({ id }).success).toBe(false);
  });
});
