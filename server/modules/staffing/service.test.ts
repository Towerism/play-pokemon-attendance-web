import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerId } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import type { TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { type StaffingService, createStaffingService } from './service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

const TZ = 'America/Chicago';
const id = (s: string) => s as PlayerId;
// 18:30 in Chicago on Wednesday the 14th is already Thursday in UTC.
const T1 = { id: 't-1', startsAt: new Date('2026-10-14T23:30:00Z'), organizerPlayerId: id('9999991') };

const staffer = (playerId: string, role: string, name = '', recordId = `rec-${playerId}`): TournamentParticipant => ({
  recordId,
  playerId: id(playerId),
  role,
  isStaff: true,
  name,
});
const playing = (playerId: string, name = ''): TournamentParticipant => ({
  recordId: `rec-${playerId}`,
  playerId: id(playerId),
  role: null,
  isStaff: false,
  name,
});

let database: OpenDatabase;
let roster: RosterService;
let staffing: StaffingService;

const history = () =>
  database.sqlite
    .prepare('select tournament_id, player_id, tournament_date, role, source from staff_history order by tournament_id, player_id')
    .all();

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  database.sqlite.prepare("insert into player (player_id, display_name, first_seen_at) values ('00123', 'Ash', 0)").run();
  roster = createRosterService({ db: database.db });
  staffing = createStaffingService({ db: database.db, roster, timeZone: TZ });
});
afterEach(() => database.close());

describe('staff_assignment table', () => {
  const insert = (removedAt: number | null = null) =>
    database.sqlite
      .prepare(
        `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, created_by, created_at, removed_at)
         values (?, '2026-10-14', 't-1', 'League Challenge', '00123', 'judge', 'organizer', 0, ?)`,
      )
      .run(L, removedAt);

  it('holds one live assignment per league, tournament and player', () => {
    insert();
    expect(() => insert()).toThrow(/UNIQUE/);
  });

  it('allows a new assignment once the earlier one is tombstoned', () => {
    insert(1);
    expect(() => insert()).not.toThrow();
  });
});

describe('recordUpstreamStaff', () => {
  beforeEach(() => database.sqlite.prepare("delete from player where player_id = '00123'").run());

  it('records each staffer on the tournament, dated in the league timezone, and makes them known', () => {
    staffing.recordUpstreamStaff(L, T1, [
      staffer('00123', 'judge', 'Old Name'),
      playing('00888', 'Player One'),
      staffer('9999991', 'organizer', 'Olive Organizer'),
    ]);

    expect(history()).toEqual([
      { tournament_id: 't-1', player_id: '00123', tournament_date: '2026-10-14', role: 'judge', source: 'upstream' },
    ]);
    expect(roster.getPlayers(L, [id('00123')])).toEqual([expect.objectContaining({ displayName: 'Old Name' })]);
  });

  it('never counts the organizer as staff, whatever role their record holds', () => {
    staffing.recordUpstreamStaff(L, T1, [staffer('9999991', 'judge', 'Olive Organizer')]);
    expect(history()).toEqual([]);
  });

  it('only seeds a name: a name the app already has is never overwritten', () => {
    roster.ensurePlayers(L, [{ playerId: id('00123'), name: 'New Name' }]);
    staffing.recordUpstreamStaff(L, T1, [staffer('00123', 'judge', 'Old Name')]);
    expect(roster.getPlayers(L, [id('00123')])[0]!.displayName).toBe('New Name');
  });

  it('returns the staffers the league did not know before', () => {
    roster.ensurePlayers(L, [{ playerId: id('00456'), name: 'Misty' }]);
    const added = staffing.recordUpstreamStaff(L, T1, [staffer('00123', 'judge'), staffer('00456', 'scorekeeper')]);
    expect(added).toEqual(['00123']);
  });

  it('keeps the latest role seen, and a row the app applied stays app', () => {
    staffing.recordAppStaff(L, [{ tournamentId: 't-1', playerId: id('00123'), role: 'judge', tournamentDate: '2026-10-14' as never }]);
    staffing.recordUpstreamStaff(L, T1, [staffer('00123', 'headjudge')]);
    expect(history()).toEqual([expect.objectContaining({ player_id: '00123', role: 'headjudge', source: 'app' })]);
  });

  it('records a tournament with no start date with a null date', () => {
    staffing.recordUpstreamStaff(L, { ...T1, startsAt: null }, [staffer('00123', 'judge')]);
    expect(history()).toEqual([expect.objectContaining({ tournament_date: null })]);
  });

  it('keeps a role the app does not offer as play-tools sent it', () => {
    staffing.recordUpstreamStaff(L, T1, [staffer('00123', 'stream_host')]);
    expect(history()).toEqual([expect.objectContaining({ role: 'stream_host' })]);
  });

  it('compares player ids as text: 00123 and 123 are different staffers', () => {
    staffing.recordUpstreamStaff(L, T1, [staffer('00123', 'judge'), staffer('123', 'judge')]);
    expect(history()).toHaveLength(2);
  });
});

describe('recordAppStaff', () => {
  it('marks an upstream row as applied by the app, with the role it applied, and writes no sighting', () => {
    staffing.recordUpstreamStaff(L, T1, [staffer('00123', 'judge')]);
    staffing.recordAppStaff(L, [{ tournamentId: 't-1', playerId: id('00123'), role: 'headjudge', tournamentDate: '2026-10-14' as never }]);

    expect(history()).toEqual([expect.objectContaining({ role: 'headjudge', source: 'app' })]);
    expect(database.sqlite.prepare('select count(*) n from sighting').get()).toEqual({ n: 0 });
  });
});

describe('searchStaff', () => {
  const at = (tournamentId: string, playerId: string, date: string | null, role = 'judge', recordedAt = 0) =>
    database.sqlite
      .prepare('insert into staff_history (league_id, tournament_id, player_id, tournament_date, role, source, recorded_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(L, tournamentId, playerId, date, role, 'upstream', recordedAt);

  beforeEach(() => {
    roster.ensurePlayers(L, [
      { playerId: id('1'), name: 'Ash' },
      { playerId: id('2'), name: 'Brock' },
      { playerId: id('3'), name: 'Cilan' },
      { playerId: id('00456'), name: 'Misty_X' },
    ]);
  });

  it('ranks by most recent tournament, then by times staffed, with the last role used', () => {
    at('t-sep', '1', '2026-09-01');
    at('t-oct1', '1', '2026-10-01');
    at('t-oct1', '2', '2026-10-01');
    at('t-oct8', '3', '2026-10-08', 'scorekeeper');

    expect(staffing.searchStaff(L, {})).toEqual([
      { playerId: '3', name: 'Cilan', timesStaffed: 1, lastStaffedOn: '2026-10-08', lastRole: 'scorekeeper' },
      { playerId: '1', name: 'Ash', timesStaffed: 2, lastStaffedOn: '2026-10-01', lastRole: 'judge' },
      { playerId: '2', name: 'Brock', timesStaffed: 1, lastStaffedOn: '2026-10-01', lastRole: 'judge' },
    ]);
  });

  it('takes the last role from the latest tournament, breaking a same-day tie by the latest recording', () => {
    at('t-a', '1', '2026-10-01', 'judge', 1);
    at('t-b', '1', '2026-10-01', 'headjudge', 2);
    at('t-old', '1', '2026-09-01', 'translator', 3);
    expect(staffing.searchStaff(L, {})[0]).toMatchObject({ lastRole: 'headjudge', timesStaffed: 3 });
  });

  it('lists staffers whose tournaments have no date last', () => {
    at('t-undated', '1', null);
    at('t-oct', '2', '2026-10-01');
    expect(staffing.searchStaff(L, {}).map((s) => [s.playerId, s.lastStaffedOn])).toEqual([
      ['2', '2026-10-01'],
      ['1', null],
    ]);
  });

  it('breaks a full tie by name', () => {
    at('t', '2', '2026-10-01');
    at('t', '1', '2026-10-01');
    expect(staffing.searchStaff(L, {}).map((s) => s.name)).toEqual(['Ash', 'Brock']);
  });

  it('matches part of a name (any case) or part of a player id, with LIKE wildcards taken literally', () => {
    at('t', '1', '2026-10-01');
    at('t', '00456', '2026-10-01');
    expect(staffing.searchStaff(L, { q: 'ASH' }).map((s) => s.playerId)).toEqual(['1']);
    expect(staffing.searchStaff(L, { q: '045' }).map((s) => s.playerId)).toEqual(['00456']);
    expect(staffing.searchStaff(L, { q: '_' }).map((s) => s.playerId)).toEqual(['00456']);
    expect(staffing.searchStaff(L, { q: '%' })).toEqual([]);
  });

  it('caps the result at limit', () => {
    at('t', '1', '2026-10-01');
    at('t', '2', '2026-10-01');
    expect(staffing.searchStaff(L, { limit: 1 })).toHaveLength(1);
  });

  it('shows the local name, and only this league\'s staff', () => {
    at('t', '1', '2026-10-01');
    roster.updatePlayer(L, id('1'), { name: 'Ash Ketchum' });
    database.sqlite.prepare("insert into league (id, name) values ('other', 'Other')").run();
    database.sqlite
      .prepare("insert into staff_history (league_id, tournament_id, player_id, tournament_date, role, source, recorded_at) values ('other', 't', '2', '2026-10-01', 'judge', 'upstream', 0)")
      .run();
    expect(staffing.searchStaff(L, {})).toEqual([expect.objectContaining({ playerId: '1', name: 'Ash Ketchum' })]);
  });
});
