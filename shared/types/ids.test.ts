import { describe, expect, it } from 'vitest';
import { toPlayerId, toSessionDate } from './ids';

describe('toPlayerId', () => {
  it('keeps leading zeros and accepts numbers', () => {
    expect(toPlayerId(' 0012345 ')).toBe('0012345');
    expect(toPlayerId(42)).toBe('42');
  });

  it.each(['', 'abc', '12-34', '1234567890123'])('rejects %j', (raw) => {
    expect(() => toPlayerId(raw)).toThrow(TypeError);
  });
});

describe('toSessionDate', () => {
  it('accepts YYYY-MM-DD and rejects anything else', () => {
    expect(toSessionDate('2026-10-14')).toBe('2026-10-14');
    expect(() => toSessionDate('2026-13-40')).toThrow(TypeError);
    expect(() => toSessionDate('10/14/2026')).toThrow(TypeError);
  });
});
