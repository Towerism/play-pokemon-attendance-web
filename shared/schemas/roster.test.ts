import { describe, expect, it } from 'vitest';
import { PlayerInput, PlayerPatch, PlayersQuery, RegularsImportBody, REGULARS_IMPORT_MAX } from './roster';

describe('PlayerInput', () => {
  it('keeps leading zeros and trims the name', () => {
    expect(PlayerInput.parse({ playerId: ' 0012345 ', name: '  Ash Ketchum ' })).toEqual({
      playerId: '0012345',
      name: 'Ash Ketchum',
    });
  });

  it('treats a blank or missing name as no name', () => {
    expect(PlayerInput.parse({ playerId: '42', name: '   ' })).toEqual({ playerId: '42' });
    expect(PlayerInput.parse({ playerId: '42' })).toEqual({ playerId: '42' });
  });

  it.each([
    ['a non-digit id', { playerId: 'abc' }],
    ['an empty id', { playerId: '' }],
    ['a 13-digit id', { playerId: '1234567890123' }],
    ['a numeric id (loses leading zeros)', { playerId: 12345 }],
    ['a missing id', { name: 'Ash' }],
    ['a name over 100 characters', { playerId: '1', name: 'x'.repeat(101) }],
  ])('rejects %s', (_label, body) => {
    expect(PlayerInput.safeParse(body).success).toBe(false);
  });
});

describe('RegularsImportBody (the CLI regulars.json)', () => {
  it('accepts the CLI shape, with numeric ids from hand-edited files', () => {
    expect(
      RegularsImportBody.parse([
        { name: 'Ash Ketchum', player_id: '0012345' },
        { name: 'Misty', player_id: 678 },
      ]),
    ).toEqual([
      { playerId: '0012345', name: 'Ash Ketchum' },
      { playerId: '678', name: 'Misty' },
    ]);
  });

  it('allows an entry without a name', () => {
    expect(RegularsImportBody.parse([{ player_id: '1' }])).toEqual([{ playerId: '1' }]);
  });

  it('ignores extra fields instead of storing them', () => {
    expect(RegularsImportBody.parse([{ player_id: '1', birthdate: '2010-01-01' }])).toEqual([{ playerId: '1' }]);
  });

  it.each([
    ['an object instead of an array', { player_id: '1' }],
    ['an invalid id', [{ player_id: 'abc' }]],
    ['a negative numeric id', [{ player_id: -1 }]],
    ['a fractional numeric id', [{ player_id: 1.5 }]],
    ['an entry without an id', [{ name: 'Ash' }]],
    ['an empty list', []],
    ['more entries than the cap', Array.from({ length: REGULARS_IMPORT_MAX + 1 }, (_, i) => ({ player_id: String(i) }))],
  ])('rejects %s', (_label, body) => {
    expect(RegularsImportBody.safeParse(body).success).toBe(false);
  });

  it('accepts exactly the cap', () => {
    const body = Array.from({ length: REGULARS_IMPORT_MAX }, (_, i) => ({ player_id: String(i) }));
    expect(RegularsImportBody.parse(body)).toHaveLength(REGULARS_IMPORT_MAX);
  });
});

describe('PlayerPatch', () => {
  it('accepts any subset of name, notes and isRegular', () => {
    expect(PlayerPatch.parse({ name: ' Brock ', notes: 'comes biweekly', isRegular: true })).toEqual({
      name: 'Brock',
      notes: 'comes biweekly',
      isRegular: true,
    });
  });

  it('lets notes be cleared with null or an empty string', () => {
    expect(PlayerPatch.parse({ notes: null })).toEqual({ notes: null });
    expect(PlayerPatch.parse({ notes: '  ' })).toEqual({ notes: null });
  });

  it.each([{}, { isRegular: 'yes' }, { name: '' }, { notes: 'x'.repeat(501) }])('rejects %j', (body) => {
    expect(PlayerPatch.safeParse(body).success).toBe(false);
  });
});

describe('PlayersQuery', () => {
  it('defaults to all players with no search', () => {
    expect(PlayersQuery.parse({})).toEqual({ filter: 'all' });
  });

  it('trims the search and drops it when blank', () => {
    expect(PlayersQuery.parse({ q: '  ash ' })).toEqual({ filter: 'all', q: 'ash' });
    expect(PlayersQuery.parse({ q: ' ' })).toEqual({ filter: 'all' });
  });

  it.each(['promote', 'stale', 'all'])('takes the %s filter', (filter) => {
    expect(PlayersQuery.parse({ filter })).toEqual({ filter });
  });

  it('rejects an unknown filter', () => {
    expect(PlayersQuery.safeParse({ filter: 'regulars' }).success).toBe(false);
  });
});
