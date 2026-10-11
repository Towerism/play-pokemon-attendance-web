import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerId } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID } from '../leagues';
import { PlayerNotFoundError, type RosterService, createRosterService } from './service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const L = DEFAULT_LEAGUE_ID;
const OTHER = 'other-league';
const id = (s: string) => s as PlayerId;

let database: OpenDatabase;
let roster: RosterService;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  database.sqlite.prepare("insert into league (id, name) values (?, 'Other')").run(OTHER);
  roster = createRosterService({ db: database.db });
});
afterEach(() => database.close());

describe('regulars', () => {
  it('starts empty', () => {
    expect(roster.listRegulars(L)).toEqual([]);
  });

  it('adds a new player as a regular, keeping the leading zeros of the id', () => {
    const result = roster.addRegular(L, { playerId: id('0012345'), name: 'Ash Ketchum' });

    expect(result).toEqual({
      added: true,
      regular: { playerId: '0012345', displayName: 'Ash Ketchum', regularSince: expect.any(Date), notes: null },
    });
    expect(roster.listRegulars(L)).toEqual([result.regular]);
  });

  it('is idempotent: adding a regular twice keeps one row and the original regularSince', () => {
    const first = roster.addRegular(L, { playerId: id('1'), name: 'Ash' });
    const second = roster.addRegular(L, { playerId: id('1'), name: 'Ash' });

    expect(second).toEqual({ added: false, regular: first.regular });
    expect(roster.listRegulars(L)).toHaveLength(1);
  });

  it('promotes a known non-regular player without changing their name', () => {
    roster.ensurePlayers(L, [{ playerId: id('1'), name: 'Ash Ketchum' }]);

    const { added, regular } = roster.addRegular(L, { playerId: id('1'), name: 'ash k' });

    expect(added).toBe(true);
    expect(regular.displayName).toBe('Ash Ketchum');
  });

  it('fills in the name of a player who had none', () => {
    roster.ensurePlayers(L, [{ playerId: id('1') }]);
    expect(roster.addRegular(L, { playerId: id('1'), name: 'Ash' }).regular.displayName).toBe('Ash');
  });

  it('lists regulars by name, case-insensitively, then by id', () => {
    roster.addRegular(L, { playerId: id('3'), name: 'misty' });
    roster.addRegular(L, { playerId: id('2'), name: 'Brock' });
    roster.addRegular(L, { playerId: id('1'), name: 'Ash' });
    roster.addRegular(L, { playerId: id('0') });

    expect(roster.listRegulars(L).map((r) => r.playerId)).toEqual(['0', '1', '2', '3']);
  });

  it('removing a regular keeps the player as a known non-regular', () => {
    roster.addRegular(L, { playerId: id('1'), name: 'Ash' });

    expect(roster.removeRegular(L, id('1'))).toBe(true);
    expect(roster.listRegulars(L)).toEqual([]);
    expect(roster.listPlayers(L)).toEqual([expect.objectContaining({ playerId: '1', isRegular: false })]);
  });

  it('removing someone who is not a regular reports false', () => {
    roster.ensurePlayers(L, [{ playerId: id('1') }]);
    expect(roster.removeRegular(L, id('1'))).toBe(false);
    expect(roster.removeRegular(L, id('999'))).toBe(false);
  });

  it('a removed regular can be added back', () => {
    roster.addRegular(L, { playerId: id('1') });
    roster.removeRegular(L, id('1'));

    const again = roster.addRegular(L, { playerId: id('1') });
    expect(again).toEqual({ added: true, regular: expect.objectContaining({ regularSince: expect.any(Date) }) });
  });

  it('keeps leagues apart', () => {
    roster.addRegular(L, { playerId: id('1'), name: 'Ash' });

    expect(roster.listRegulars(OTHER)).toEqual([]);
    expect(roster.removeRegular(OTHER, id('1'))).toBe(false);
    expect(roster.regularIds(L)).toEqual(new Set(['1']));
    expect(roster.regularIds(OTHER)).toEqual(new Set());
  });
});

describe('importRegulars (CLI regulars.json)', () => {
  it('adds every player and counts what changed', () => {
    roster.addRegular(L, { playerId: id('1'), name: 'Ash' });

    const result = roster.importRegulars(L, [
      { playerId: id('1'), name: 'Ash' },
      { playerId: id('2'), name: 'Brock' },
      { playerId: id('003'), name: 'Misty' },
    ]);

    expect(result).toEqual({ added: 2, alreadyRegular: 1 });
    expect(roster.listRegulars(L).map((r) => r.playerId)).toEqual(['1', '2', '003']);
  });

  it('collapses duplicate ids in the file, keeping the first non-empty name', () => {
    const result = roster.importRegulars(L, [
      { playerId: id('1') },
      { playerId: id('1'), name: 'Ash' },
      { playerId: id('1'), name: 'Ash Ketchum' },
    ]);

    expect(result).toEqual({ added: 1, alreadyRegular: 0 });
    expect(roster.listRegulars(L)).toEqual([expect.objectContaining({ playerId: '1', displayName: 'Ash' })]);
  });

  it('is all-or-nothing', () => {
    database.sqlite.exec(
      "create trigger boom before insert on player when new.player_id = '666' begin select raise(abort, 'boom'); end",
    );

    expect(() =>
      roster.importRegulars(L, [
        { playerId: id('1'), name: 'Ash' },
        { playerId: id('666'), name: 'Fails' },
      ]),
    ).toThrow(/boom/);
    expect(roster.listRegulars(L)).toEqual([]);
    expect(roster.listPlayers(L)).toEqual([]);
  });
});

describe('players', () => {
  it('ensurePlayers records new players once and never overwrites an existing name', () => {
    roster.ensurePlayers(L, [{ playerId: id('1'), name: 'Ash' }, { playerId: id('2') }]);
    roster.ensurePlayers(L, [
      { playerId: id('1'), name: 'Someone Else' },
      { playerId: id('2'), name: 'Brock' },
    ]);

    expect(roster.listPlayers(L)).toEqual([
      { playerId: '1', displayName: 'Ash', isRegular: false, notes: null, firstSeenAt: expect.any(Date) },
      { playerId: '2', displayName: 'Brock', isRegular: false, notes: null, firstSeenAt: expect.any(Date) },
    ]);
  });

  it('a player known in another league is not listed here until seen here', () => {
    roster.ensurePlayers(OTHER, [{ playerId: id('1'), name: 'Ash' }]);
    expect(roster.listPlayers(L)).toEqual([]);

    roster.ensurePlayers(L, [{ playerId: id('1') }]);
    expect(roster.listPlayers(L)).toEqual([expect.objectContaining({ playerId: '1', displayName: 'Ash' })]);
  });

  describe('search', () => {
    beforeEach(() => {
      roster.ensurePlayers(L, [
        { playerId: id('0012345'), name: 'Ash Ketchum' },
        { playerId: id('5550001'), name: 'Misty Waterflower' },
        { playerId: id('777'), name: '100%_Brock' },
      ]);
    });

    it.each([
      ['a name fragment, case-insensitively', 'ketch', ['0012345']],
      ['an id prefix with leading zeros', '0012', ['0012345']],
      ['an id fragment in the middle', '500', ['5550001']],
      ['LIKE wildcards literally', '%_', ['777']],
      ['nothing', 'zzz', []],
    ])('matches %s', (_label, q, ids) => {
      expect(roster.listPlayers(L, { q }).map((p) => p.playerId)).toEqual(ids);
    });
  });

  describe('updatePlayer', () => {
    beforeEach(() => roster.ensurePlayers(L, [{ playerId: id('1'), name: 'Ash' }]));

    it('renames and sets notes', () => {
      expect(roster.updatePlayer(L, id('1'), { name: 'Ash Ketchum', notes: 'brings snacks' })).toEqual(
        expect.objectContaining({ playerId: '1', displayName: 'Ash Ketchum', notes: 'brings snacks', isRegular: false }),
      );
    });

    it('clears notes with null', () => {
      roster.updatePlayer(L, id('1'), { notes: 'x' });
      expect(roster.updatePlayer(L, id('1'), { notes: null }).notes).toBeNull();
    });

    it('toggles regular on and off', () => {
      expect(roster.updatePlayer(L, id('1'), { isRegular: true }).isRegular).toBe(true);
      expect(roster.listRegulars(L)).toEqual([expect.objectContaining({ playerId: '1', regularSince: expect.any(Date) })]);

      expect(roster.updatePlayer(L, id('1'), { isRegular: false }).isRegular).toBe(false);
      expect(roster.listRegulars(L)).toEqual([]);
    });

    it('keeps regularSince when isRegular: true is sent again', () => {
      const since = roster.updatePlayer(L, id('1'), { isRegular: true }) && roster.listRegulars(L)[0]!.regularSince;
      roster.updatePlayer(L, id('1'), { isRegular: true });
      expect(roster.listRegulars(L)[0]!.regularSince).toEqual(since);
    });

    it('throws PlayerNotFoundError for a player unknown in this league', () => {
      expect(() => roster.updatePlayer(L, id('999'), { name: 'x' })).toThrow(PlayerNotFoundError);
      expect(() => roster.updatePlayer(OTHER, id('1'), { name: 'x' })).toThrow(PlayerNotFoundError);
    });

    it('renaming in one league renames the player everywhere (names belong to the player)', () => {
      roster.ensurePlayers(OTHER, [{ playerId: id('1') }]);
      roster.updatePlayer(L, id('1'), { name: 'Ash Ketchum' });
      expect(roster.listPlayers(OTHER)[0]!.displayName).toBe('Ash Ketchum');
    });
  });

  it('getPlayers returns the requested known players in this league', () => {
    roster.ensurePlayers(L, [{ playerId: id('1'), name: 'Ash' }, { playerId: id('2') }]);
    roster.ensurePlayers(OTHER, [{ playerId: id('3') }]);

    expect(roster.getPlayers(L, [id('2'), id('3'), id('1')]).map((p) => p.playerId).sort()).toEqual(['1', '2']);
    expect(roster.getPlayers(L, [])).toEqual([]);
  });
});
