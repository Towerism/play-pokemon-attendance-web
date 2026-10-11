import { describe, expect, it } from 'vitest';
import { generateSetupCode, setupCodeMatches } from './setup-code';

describe('generateSetupCode', () => {
  it('is two groups of four easy-to-read characters (read off a log, typed by hand)', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateSetupCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it('is unpredictable', () => {
    const codes = new Set(Array.from({ length: 1000 }, generateSetupCode));
    expect(codes.size).toBe(1000);
  });
});

describe('setupCodeMatches', () => {
  const code = 'ABCD-EF23';

  it.each(['ABCD-EF23', 'abcd-ef23', ' ABCDEF23 ', 'abcd ef23'])('accepts %j', (given) => {
    expect(setupCodeMatches(code, given)).toBe(true);
  });

  it.each(['ABCD-EF24', 'ABCD-EF2', 'ABCD-EF233', '', '--------'])('rejects %j', (given) => {
    expect(setupCodeMatches(code, given)).toBe(false);
  });
});
