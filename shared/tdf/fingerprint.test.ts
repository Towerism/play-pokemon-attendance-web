import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex, warningsFingerprint } from './fingerprint';

const nodeSha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it.each([
    ['', 'empty'],
    ['abc', 'one block'],
    ['a'.repeat(55), 'padding fits in the block'],
    ['a'.repeat(56), 'padding needs a second block'],
    ['x'.repeat(64), 'exactly one block'],
    ['tdf_staff_also_playing|1234567,judge\n'.repeat(40), 'many blocks'],
    ['Ñúñez · 寿司 · 🎴', 'multi-byte UTF-8'],
  ])('matches node:crypto for %j (%s)', (text) => {
    expect(sha256Hex(text)).toBe(nodeSha(text));
  });
});

describe('warningsFingerprint', () => {
  const staff = { code: 'tdf_staff_also_playing', subjects: ['1234567', 'judge'] };
  const game = { code: 'tdf_wrong_game', subjects: ['vg'] };
  const unknown = { code: 'tdf_unknown_players', subjects: ['333', '111', '222'] };

  it('is the SHA-256 of the empty string for no warnings', () => {
    expect(warningsFingerprint([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('ignores the order of warnings and of their subjects', () => {
    const a = warningsFingerprint([staff, game, unknown]);
    const b = warningsFingerprint([unknown, { ...staff, subjects: ['judge', '1234567'] }, game]);
    expect(a).toBe(b);
  });

  it('is the hash of the sorted canonical lines', () => {
    expect(warningsFingerprint([game, unknown])).toBe(nodeSha('tdf_unknown_players|111,222,333\ntdf_wrong_game|vg'));
  });

  it('changes when any code or subject changes, or a warning is added', () => {
    const base = warningsFingerprint([staff, game]);
    expect(warningsFingerprint([{ ...staff, subjects: ['1234568', 'judge'] }, game])).not.toBe(base);
    expect(warningsFingerprint([{ ...staff, code: 'tdf_wrong_organizer' }, game])).not.toBe(base);
    expect(warningsFingerprint([staff, game, unknown])).not.toBe(base);
    expect(warningsFingerprint([staff])).not.toBe(base);
  });

  it('keeps two warnings of the same code apart', () => {
    const two = warningsFingerprint([staff, { code: 'tdf_staff_also_playing', subjects: ['7654321', 'organizer'] }]);
    expect(two).not.toBe(warningsFingerprint([staff]));
  });
});
