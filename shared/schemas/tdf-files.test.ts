import { describe, expect, it } from 'vitest';
import { TdfFileIdParam, TdfFilesQuery } from './tdf-files';

describe('TdfFileIdParam', () => {
  it('coerces a positive integer id from the path', () => {
    expect(TdfFileIdParam.parse({ id: '12' })).toEqual({ id: 12 });
  });

  it.each(['abc', '0', '-1', '1.5', '', '1e3'])('rejects %j', (id) => {
    expect(TdfFileIdParam.safeParse({ id }).success).toBe(false);
  });
});

describe('TdfFilesQuery', () => {
  it('takes an optional tournament id and tournament date', () => {
    expect(TdfFilesQuery.parse({})).toEqual({});
    expect(TdfFilesQuery.parse({ tournamentId: '26-10-000123', date: '2026-10-14' })).toEqual({
      tournamentId: '26-10-000123',
      date: '2026-10-14',
    });
    expect(TdfFilesQuery.parse({ tournamentId: 'x'.repeat(64) }).tournamentId).toHaveLength(64);
  });

  it.each([
    [{ date: '2026-02-30' }],
    [{ date: '10/14/2026' }],
    [{ tournamentId: '' }],
    [{ tournamentId: 'x'.repeat(65) }],
  ])('rejects %j', (query) => {
    expect(TdfFilesQuery.safeParse(query).success).toBe(false);
  });
});
