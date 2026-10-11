import { describe, expect, it } from 'vitest';
import { SessionDateParam, SessionPlayerParams } from './sessions';

describe('SessionDateParam', () => {
  it('accepts a real calendar date', () => {
    expect(SessionDateParam.parse({ date: '2026-10-14' })).toEqual({ date: '2026-10-14' });
  });

  it.each(['2026-13-01', '2026-02-30', '10/14/2026', '2026-1-4', ''])('rejects %j', (date) => {
    expect(SessionDateParam.safeParse({ date }).success).toBe(false);
  });
});

describe('SessionPlayerParams', () => {
  it('keeps the leading zeros of the player id', () => {
    expect(SessionPlayerParams.parse({ date: '2026-10-14', playerId: '007' })).toEqual({
      date: '2026-10-14',
      playerId: '007',
    });
  });
});
