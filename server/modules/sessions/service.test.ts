import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import { type RosterService, createRosterService } from '../roster/service';
import { AlreadyRegularError, type SessionsService, createSessionsService } from './service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const OTHER = 'other-league';
const id = (s: string) => s as PlayerId;
const WED = '2026-10-14' as SessionDate;
const NEXT_WED = '2026-10-21' as SessionDate;

let database: OpenDatabase;
let roster: RosterService;
let sightings: SightingsService;
let sessions: SessionsService;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  database.sqlite.prepare("insert into league (id, name) values (?, 'Other')").run(OTHER);
  roster = createRosterService({ db: database.db });
  sightings = createSightingsService({ db: database.db });
  sessions = createSessionsService({ db: database.db, roster, sightings });
});
afterEach(() => database.close());

describe('getSession', () => {
  it('shows an empty draft for a date nobody has touched, without creating it', () => {
    expect(sessions.getSession(L, WED)).toEqual({
      date: WED,
      status: 'draft',
      playSessionId: null,
      players: [],
      regulars: [],
      imports: [],
    });
    expect(database.sqlite.prepare('select count(*) n from session_draft').get()).toEqual({ n: 0 });
  });

  it('lists the regulars who will be submitted alongside the session players', () => {
    roster.addRegular(L, { playerId: id('9'), name: 'Brock' });
    expect(sessions.getSession(L, WED).regulars).toEqual([
      expect.objectContaining({ playerId: '9', displayName: 'Brock' }),
    ]);
  });
});

describe('addPlayer', () => {
  it('adds a new player to the date, records them as known, and logs a manual sighting', () => {
    const result = sessions.addPlayer(L, WED, { playerId: id('0042'), name: 'Ash' });

    expect(result).toEqual({ added: true, player: { playerId: '0042', displayName: 'Ash', source: 'manual' } });
    expect(sessions.getSession(L, WED).players).toEqual([result.player]);
    expect(roster.listPlayers(L)).toEqual([expect.objectContaining({ playerId: '0042', isRegular: false })]);
    expect(sightings.on(L, WED)).toEqual([{ playerId: '0042', kind: 'manual' }]);
  });

  it('is idempotent: adding the same player twice lists them once', () => {
    sessions.addPlayer(L, WED, { playerId: id('1'), name: 'Ash' });
    const again = sessions.addPlayer(L, WED, { playerId: id('1'), name: 'Ash' });

    expect(again.added).toBe(false);
    expect(sessions.getSession(L, WED).players).toHaveLength(1);
  });

  it('uses the name already on file for a known player', () => {
    roster.ensurePlayers(L, [{ playerId: id('1'), name: 'Ash Ketchum' }]);
    expect(sessions.addPlayer(L, WED, { playerId: id('1'), name: 'ash' }).player.displayName).toBe('Ash Ketchum');
  });

  it('refuses a regular (they are submitted every week anyway) and changes nothing', () => {
    roster.addRegular(L, { playerId: id('9'), name: 'Brock' });

    expect(() => sessions.addPlayer(L, WED, { playerId: id('9') })).toThrow(AlreadyRegularError);
    expect(sessions.getSession(L, WED).players).toEqual([]);
    expect(sightings.on(L, WED)).toEqual([]);
  });

  it('keeps each date its own list', () => {
    sessions.addPlayer(L, WED, { playerId: id('1') });
    sessions.addPlayer(L, NEXT_WED, { playerId: id('2') });

    expect(sessions.getSession(L, WED).players.map((p) => p.playerId)).toEqual(['1']);
    expect(sessions.getSession(L, NEXT_WED).players.map((p) => p.playerId)).toEqual(['2']);
  });

  it('keeps leagues apart', () => {
    sessions.addPlayer(L, WED, { playerId: id('1') });
    expect(sessions.getSession(OTHER, WED).players).toEqual([]);
  });

  it('lists session players by name, then id', () => {
    sessions.addPlayer(L, WED, { playerId: id('3'), name: 'misty' });
    sessions.addPlayer(L, WED, { playerId: id('2'), name: 'Ash' });
    sessions.addPlayer(L, WED, { playerId: id('1') });

    expect(sessions.getSession(L, WED).players.map((p) => p.playerId)).toEqual(['1', '2', '3']);
  });

  it('rolls back the player and the draft when the sighting cannot be written', () => {
    database.sqlite.exec("create trigger boom before insert on sighting begin select raise(abort, 'boom'); end");

    expect(() => sessions.addPlayer(L, WED, { playerId: id('1'), name: 'Ash' })).toThrow(/boom/);
    expect(database.sqlite.prepare('select count(*) n from session_draft').get()).toEqual({ n: 0 });
    expect(roster.listPlayers(L)).toEqual([]);
  });
});

describe('recordSubmission', () => {
  it('stores the resolved play session and the submission state on the draft (§4.4 step 4)', () => {
    sessions.recordSubmission(L, WED, { playSessionId: 'ps-1', status: 'submitting' });
    expect(sessions.getSession(L, WED)).toMatchObject({ status: 'submitting', playSessionId: 'ps-1' });

    sessions.recordSubmission(L, WED, { playSessionId: 'ps-1', status: 'partial' });
    expect(sessions.getSession(L, WED).status).toBe('partial');
  });

  it('keeps the players already listed for the date', () => {
    sessions.addPlayer(L, WED, { playerId: id('1') });
    sessions.recordSubmission(L, WED, { playSessionId: 'ps-1', status: 'submitted' });
    expect(sessions.getSession(L, WED).players).toHaveLength(1);
  });
});

describe('removePlayer', () => {
  beforeEach(() => {
    sessions.addPlayer(L, WED, { playerId: id('1'), name: 'Ash' });
    sessions.addPlayer(L, NEXT_WED, { playerId: id('1'), name: 'Ash' });
  });

  it('takes the player off that date only and retracts that manual sighting', () => {
    expect(sessions.removePlayer(L, WED, id('1'))).toBe(true);

    expect(sessions.getSession(L, WED).players).toEqual([]);
    expect(sightings.on(L, WED)).toEqual([]);
    expect(sessions.getSession(L, NEXT_WED).players).toHaveLength(1);
    expect(sightings.on(L, NEXT_WED)).toEqual([{ playerId: '1', kind: 'manual' }]);
  });

  it('keeps the player on file (every player who entered the system is tracked)', () => {
    sessions.removePlayer(L, WED, id('1'));
    expect(roster.listPlayers(L)).toEqual([expect.objectContaining({ playerId: '1' })]);
  });

  it('reports false for a player not on that date, or a date with no draft', () => {
    expect(sessions.removePlayer(L, WED, id('2'))).toBe(false);
    expect(sessions.removePlayer(L, '2026-12-25' as SessionDate, id('1'))).toBe(false);
    expect(sessions.removePlayer(OTHER, WED, id('1'))).toBe(false);
  });
});
