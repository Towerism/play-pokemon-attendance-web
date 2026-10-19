import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import { type RosterService, createRosterService } from '../roster/service';
import { StaffingError } from './errors';
import { type StaffingService, createStaffingService } from './service';
import { OLIVE, playing, staffer, stubPlayTools, tournament } from './test-helpers';
import { HELD_BY_OWNER, OWNER, professorActor } from '../pokemon/test-connections';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

const TZ = 'America/Chicago';
const id = (s: string) => s as PlayerId;
// 18:30 in Chicago on Wednesday the 14th is already Thursday in UTC.
const T1 = { id: 't-1', startsAt: new Date('2026-10-14T23:30:00Z'), organizerPlayerId: id('9999991') };

let database: OpenDatabase;
let roster: RosterService;
let staffing: StaffingService;
let upstream: ReturnType<typeof stubPlayTools>;
const NOW = new Date('2026-10-14T12:00:00Z');

const history = () =>
  database.sqlite
    .prepare('select tournament_id, player_id, tournament_date, role, source from staff_history order by tournament_id, player_id')
    .all();

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  database.sqlite.prepare("insert into player (player_id, display_name, first_seen_at) values ('00123', 'Ash', 0)").run();
  roster = createRosterService({ db: database.db });
  upstream = stubPlayTools();
  staffing = createStaffingService({
    db: database.db,
    roster,
    connections: upstream.connections,
    staffGateway: upstream.gateway,
    timeZone: TZ,
    now: () => NOW,
  });
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

describe('sessionStaff', () => {
  const WED = '2026-10-14' as never;
  const addAssignment = (row: { tournamentId: string; playerId: string; role?: string; recordId?: string; removedAt?: number; date?: string }) =>
    database.sqlite
      .prepare(
        `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, state, record_id, removed_at, created_by, created_at)
         values (?, ?, ?, 'Stored label', ?, ?, ?, ?, ?, 'organizer', 0)`,
      )
      .run(L, row.date ?? WED, row.tournamentId, row.playerId, row.role ?? 'judge', row.removedAt ? 'removing' : row.recordId ? 'assigned' : 'pending', row.recordId ?? null, row.removedAt ?? null).lastInsertRowid;

  it("lists only this league's tournaments that start on the date in the league timezone, by start", async () => {
    upstream.state.tournaments = [
      tournament('late', { startsAt: new Date('2026-10-15T01:00:00Z') }), // 20:00 Wed in Chicago
      tournament('early', { startsAt: new Date('2026-10-14T17:00:00Z') }),
      tournament('thursday', { startsAt: new Date('2026-10-15T06:00:00Z') }), // 01:00 Thu in Chicago
      tournament('elsewhere', { startsAt: new Date('2026-10-14T18:00:00Z'), groupId: 'another-store' }),
    ];
    const view = await staffing.sessionStaff(L, WED);
    expect(view.timeZone).toBe(TZ);
    expect(view.tournaments.map((t) => t.tournamentId)).toEqual(['early', 'late']);
  });

  it('describes each tournament: label, start, editable, organizer and who is playing', async () => {
    upstream.addProfessor({ id: 1, professorPlayerId: '777' });
    upstream.state.tournaments = [tournament('t-1', { name: 'League Challenge', displayId: '26-10-900001', organizer: '777' })];
    upstream.state.participants.set('t-1', [playing('00888'), staffer('777', 'organizer'), playing('00889')]);

    const [t] = (await staffing.sessionStaff(L, WED)).tournaments;
    expect(t).toEqual({
      tournamentId: 't-1',
      label: 'League Challenge · 26-10-900001',
      startsAt: '2026-10-14T23:30:00.000Z',
      editable: true,
      organizer: { playerId: '777', name: null, connected: true, needsReconnect: false },
      assignments: [],
      upstreamOnly: [],
      players: [{ playerId: '00888' }, { playerId: '00889' }],
    });
  });

  it.each([
    [{ name: 'LC', displayId: null }, 'LC'],
    [{ name: null, displayId: '26-10-1' }, '26-10-1'],
    [{ name: null, displayId: null }, 't-1'],
  ])('labels a tournament from the parts it has (%j)', async (parts, label) => {
    upstream.state.tournaments = [tournament('t-1', parts)];
    expect((await staffing.sessionStaff(L, WED)).tournaments[0]!.label).toBe(label);
  });

  it('marks a tournament past its edit window, or with no window, as not editable', async () => {
    upstream.state.tournaments = [
      tournament('past', { editableUntil: new Date('2026-10-14T11:59:59Z') }),
      tournament('unknown', { editableUntil: null }),
    ];
    expect((await staffing.sessionStaff(L, WED)).tournaments.map((t) => t.editable)).toEqual([false, false]);
  });

  it("shows the league's assignments with local names, and play-tools-only staff apart from them", async () => {
    roster.ensurePlayers(L, [{ playerId: id('00123'), name: 'Ash' }, { playerId: id('00456'), name: 'Misty' }]);
    upstream.state.tournaments = [tournament('t-1')];
    upstream.state.participants.set('t-1', [
      staffer('00123', 'judge', 'Old Name', 'rec-ours'),
      staffer('00777', 'scorekeeper', 'Someone Else', 'rec-theirs'),
      staffer('9999991', 'organizer'),
    ]);
    const applied = addAssignment({ tournamentId: 't-1', playerId: '00123', recordId: 'rec-ours' });
    const pending = addAssignment({ tournamentId: 't-1', playerId: '00456', role: 'scorekeeper' });

    const [t] = (await staffing.sessionStaff(L, WED)).tournaments;
    expect(t!.assignments).toEqual([
      { id: Number(applied), playerId: '00123', name: 'Ash', role: 'judge', appliedRole: null, state: 'assigned' },
      { id: Number(pending), playerId: '00456', name: 'Misty', role: 'scorekeeper', appliedRole: null, state: 'pending' },
    ]);
    expect(t!.upstreamOnly).toEqual([{ playerId: '00777', name: 'Someone Else', role: 'scorekeeper' }]);
  });

  it('seeds the staff list from what it read, so play-tools-only staff become searchable', async () => {
    upstream.state.tournaments = [tournament('t-1')];
    upstream.state.participants.set('t-1', [staffer('00777', 'judge', 'Someone Else')]);
    await staffing.sessionStaff(L, WED);
    expect(staffing.searchStaff(L, {})).toEqual([expect.objectContaining({ playerId: '00777', name: 'Someone Else', lastStaffedOn: '2026-10-14' })]);
  });

  it('still shows a removed assignment until the staff job deletes it', async () => {
    upstream.state.tournaments = [tournament('t-1')];
    upstream.state.participants.set('t-1', [staffer('00123', 'judge', '', 'rec-ours')]);
    addAssignment({ tournamentId: 't-1', playerId: '00123', recordId: 'rec-ours', removedAt: 1 });
    const [t] = (await staffing.sessionStaff(L, WED)).tournaments;
    expect(t!.assignments).toEqual([expect.objectContaining({ state: 'removing' })]);
    expect(t!.upstreamOnly).toEqual([]);
  });

  it('keeps assignments for a tournament play-tools no longer lists visible, as missing', async () => {
    addAssignment({ tournamentId: 'cancelled', playerId: '00123' });
    const view = await staffing.sessionStaff(L, WED);
    expect(view.tournaments).toEqual([
      expect.objectContaining({ tournamentId: 'cancelled', label: 'Stored label', missing: true, editable: false, organizer: null, startsAt: null, players: [], upstreamOnly: [] }),
    ]);
    expect(view.tournaments[0]!.assignments).toHaveLength(1);
  });

  it('shows only the live assignments of a tournament play-tools no longer lists', async () => {
    database.sqlite.prepare("insert into player (player_id, display_name, first_seen_at) values ('00456', 'Misty', 0)").run();
    addAssignment({ tournamentId: 'gone', playerId: '00123' });
    addAssignment({ tournamentId: 'gone', playerId: '00456', recordId: 'rec-1', removedAt: 5 });

    const view = await staffing.sessionStaff(L, WED);

    expect(view.tournaments).toEqual([expect.objectContaining({ tournamentId: 'gone', missing: true })]);
    expect(view.tournaments[0]!.assignments).toEqual([expect.objectContaining({ playerId: '00123', state: 'pending' })]);
  });

  it('shows the tombstones again, as removing, if a tournament thought cancelled is listed after all', async () => {
    upstream.state.tournaments = [tournament('t-1')];
    upstream.state.participants.set('t-1', [staffer('00123', 'judge', '', 'rec-ours')]);
    addAssignment({ tournamentId: 't-1', playerId: '00123', recordId: 'rec-ours' });
    staffing.cancelTournament(L, 't-1');
    const listed = upstream.state.tournaments;
    upstream.state.tournaments = [];
    expect((await staffing.sessionStaff(L, WED)).tournaments).toEqual([]);

    upstream.state.tournaments = listed;
    const [t] = (await staffing.sessionStaff(L, WED)).tournaments;

    expect(t).toMatchObject({ tournamentId: 't-1', assignments: [expect.objectContaining({ playerId: '00123', state: 'removing' })] });
    expect(t!.missing).toBeUndefined();
  });

  it('shows nothing for a cancelled tournament whose staff were only tombstoned, and keeps the tombstones', async () => {
    upstream.state.tournaments = [tournament('t-1')];
    addAssignment({ tournamentId: 't-1', playerId: '00123', recordId: 'rec-ours' });
    staffing.cancelTournament(L, 't-1');
    upstream.state.tournaments = []; // play-tools stops listing a cancelled tournament

    expect((await staffing.sessionStaff(L, WED)).tournaments).toEqual([]);
    expect(staffing.assignmentsFor(L, 't-1')).toEqual([expect.objectContaining({ playerId: '00123', removed: true })]);
  });

  it('leaves out a tournament deleted between listing it and reading it', async () => {
    upstream.state.tournaments = [tournament('t-1'), tournament('t-2', { startsAt: new Date('2026-10-14T23:45:00Z') })];
    upstream.state.gone.add('t-1');
    expect((await staffing.sessionStaff(L, WED)).tournaments.map((t) => t.tournamentId)).toEqual(['t-2']);
  });

  it('reads play-tools one call at a time: the list, then details and participants per tournament', async () => {
    upstream.state.tournaments = [tournament('a', { startsAt: new Date('2026-10-14T17:00:00Z') }), tournament('b')];
    await staffing.sessionStaff(L, WED);
    expect(upstream.maxConcurrentCalls()).toBe(1);
    expect(upstream.state.calls.map((c) => c.split(' ')[0])).toEqual([
      'listTournaments',
      'getTournament',
      'listTournamentParticipants',
      'getTournament',
      'listTournamentParticipants',
    ]);
  });

  it('refuses without a selected league, before calling play-tools', async () => {
    upstream.state.connection = { ...upstream.state.connection, league: null };
    await expect(staffing.sessionStaff(L, WED)).rejects.toEqual(expect.objectContaining({ code: 'league_not_selected' }));
    await expect(staffing.sessionStaff(L, WED)).rejects.toBeInstanceOf(StaffingError);
    expect(upstream.state.calls).toEqual([]);
  });

  it('refuses with not_connected when no professor is connected, before calling play-tools', async () => {
    upstream.state.connection = { ...upstream.state.connection, league: null };
    upstream.state.professors = [];
    await expect(staffing.sessionStaff(L, WED)).rejects.toEqual(expect.objectContaining({ name: 'PokemonUpstreamError', code: 'not_connected' }));
    expect(upstream.state.calls).toEqual([]);
  });

  it("names the professor it couldn't read when play-tools is unavailable, seeding nothing for the tournament it couldn't read", async () => {
    upstream.state.tournaments = [tournament('t-1')];
    upstream.state.participants.set('t-1', [staffer('00777', 'judge')]);
    upstream.state.failNext.set('listTournamentParticipants', new PokemonUpstreamError('unavailable', 'down'));
    const view = await staffing.sessionStaff(L, WED);
    expect(view.tournaments).toEqual([]);
    expect(view.unread).toEqual([{ professor: { playerId: '9999991', name: 'Olive Organizer' }, code: 'unavailable', message: 'down' }]);
    expect(history()).toEqual([]);
  });
});

describe('sessionStaff with several professors (#75)', () => {
  const WED = '2026-10-14' as never;
  const BROCK = { id: 2, professorPlayerId: '0000222', professorName: 'Brock Harrison' };
  const CILAN = { id: 3, professorPlayerId: '0000333', professorName: null };
  const assign = (tournamentId: string) =>
    database.sqlite
      .prepare(
        `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, created_by, created_at)
         values (?, ?, ?, 'Stored label', '00123', 'judge', 'organizer', 0)`,
      )
      .run(L, WED, tournamentId);
  /** Every call that names a tournament, with the professor it was made as. */
  const tournamentCallsAs = () =>
    upstream.state.callsAs.filter((c) => !c.call.startsWith('listTournaments')).map((c) => [c.call.split(' ')[1], c.as]);

  beforeEach(() => {
    upstream.addProfessor(BROCK);
    upstream.state.tournaments = [
      tournament('olives', { startsAt: new Date('2026-10-14T23:30:00Z') }),
      tournament('brocks', { startsAt: new Date('2026-10-14T22:00:00Z'), organizer: '0000222' }),
      tournament('brocks-elsewhere', { startsAt: new Date('2026-10-14T21:00:00Z'), organizer: '0000222', groupId: 'another-store' }),
    ];
  });

  it("lists every professor's tournaments in this league by start, each with its organizer, every call made as that organizer", async () => {
    const view = await staffing.sessionStaff(L, WED);

    expect(view.tournaments.map((t) => [t.tournamentId, t.organizer, t.editable])).toEqual([
      ['brocks', { playerId: '0000222', name: 'Brock Harrison', connected: true, needsReconnect: false }, true],
      ['olives', { playerId: '9999991', name: 'Olive Organizer', connected: true, needsReconnect: false }, true],
    ]);
    expect(view.unread).toEqual([]);
    expect(tournamentCallsAs()).toEqual([
      ['olives', 1],
      ['olives', 1],
      ['brocks', 2],
      ['brocks', 2],
    ]);
  });

  it('shows and reads a tournament two connections list only once', async () => {
    upstream.addProfessor({ id: 4, professorPlayerId: null, upstreamAs: '9999991' });
    const view = await staffing.sessionStaff(L, WED);
    expect(view.tournaments.map((t) => t.tournamentId)).toEqual(['brocks', 'olives']);
    expect(upstream.state.calls.filter((c) => c === 'getTournament olives')).toHaveLength(1);
  });

  it("still shows everyone else's tournaments when the submitting professor needs a reconnect, naming them, without calling as them", async () => {
    upstream.addProfessor({ ...OLIVE, status: 'needs_reconnect' });

    const view = await staffing.sessionStaff(L, WED);
    expect(view.tournaments.map((t) => t.tournamentId)).toEqual(['brocks']);
    expect(view.unread).toEqual([
      { professor: { playerId: '9999991', name: 'Olive Organizer' }, code: 'needs_reconnect', message: expect.any(String) },
    ]);
    expect(upstream.state.callsAs.filter((c) => c.as === 1)).toEqual([]);
  });

  it.each([
    ['its listing', 'listTournaments'],
    ['a tournament it organizes', 'listTournamentParticipants'],
  ])("isolates one professor's failure reading %s: the others show unchanged, and nothing of theirs goes through another login", async (_l, method) => {
    upstream.state.failNextAs.set(`${method}@2`, new PokemonUpstreamError('unavailable', 'play-tools is down'));

    const view = await staffing.sessionStaff(L, WED);
    expect(view.tournaments.map((t) => t.tournamentId)).toEqual(['olives']);
    expect(view.unread).toEqual([{ professor: { playerId: '0000222', name: 'Brock Harrison' }, code: 'unavailable', message: 'play-tools is down' }]);
    expect(upstream.state.callsAs.filter((c) => c.call.endsWith(' brocks') && c.as !== 2)).toEqual([]);
  });

  it("shows an assignment on a tournament nobody listed as unavailable when a professor couldn't be read, and missing when everyone was", async () => {
    assign('cancelled');
    expect((await staffing.sessionStaff(L, WED)).tournaments.find((t) => t.tournamentId === 'cancelled')).toMatchObject({ missing: true, editable: false });

    upstream.state.failNextAs.set('listTournaments@2', new PokemonUpstreamError('unavailable', 'down'));
    const view = await staffing.sessionStaff(L, WED);
    const shown = view.tournaments.find((t) => t.tournamentId === 'cancelled')!;
    expect(shown).toMatchObject({ unavailable: true, editable: false, organizer: null });
    expect(shown.missing).toBeUndefined();
  });

  it("keeps a tombstone on a tournament nobody listed while a professor couldn't be read, since it may still be theirs", async () => {
    database.sqlite
      .prepare(
        `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, state, record_id, removed_at, created_by, created_at)
         values (?, ?, 'maybe-brocks', 'Stored label', '00123', 'judge', 'removing', 'rec-1', 5, 'organizer', 0)`,
      )
      .run(L, WED);
    upstream.state.failNextAs.set('listTournaments@2', new PokemonUpstreamError('unavailable', 'down'));

    const shown = (await staffing.sessionStaff(L, WED)).tournaments.find((t) => t.tournamentId === 'maybe-brocks');

    expect(shown).toMatchObject({ unavailable: true, assignments: [expect.objectContaining({ playerId: '00123', state: 'removing' })] });
  });

  it('answers with no tournaments and every professor named when nobody can be read', async () => {
    assign('olives');
    upstream.state.failNextAs.set('listTournaments@1', new PokemonUpstreamError('unavailable', 'down'));
    upstream.state.failNextAs.set('listTournaments@2', new PokemonUpstreamError('rate_limited', 'slow down'));
    const view = await staffing.sessionStaff(L, WED);
    expect(view.unread.map((u) => [u.professor.playerId, u.code])).toEqual([
      ['9999991', 'unavailable'],
      ['0000222', 'rate_limited'],
    ]);
    expect(view.tournaments).toEqual([expect.objectContaining({ tournamentId: 'olives', unavailable: true, editable: false })]);
  });

  it("seeds the staff list from another professor's tournament", async () => {
    upstream.state.participants.set('brocks', [staffer('0000222', 'organizer'), staffer('00555', 'judge', 'Jo Judge')]);
    await staffing.sessionStaff(L, WED);
    expect(staffing.searchStaff(L, {}).map((s) => s.playerId)).toEqual(['00555']);
  });

  it("shows a tournament whose organizer isn't an identified, connected professor as read-only", async () => {
    upstream.state.professors = [{ id: 5, professorPlayerId: null, professorName: null, status: 'connected', ...HELD_BY_OWNER, upstreamAs: '0000222' }];
    const [t] = (await staffing.sessionStaff(L, WED)).tournaments;
    expect(t).toMatchObject({ tournamentId: 'brocks', editable: false, organizer: { playerId: '0000222', name: null, connected: false, needsReconnect: false } });
  });

  it('matches the organizer by exact player id: 222 is not 0000222', async () => {
    upstream.state.professors = [{ id: 6, professorPlayerId: '222', professorName: null, status: 'connected', ...HELD_BY_OWNER, upstreamAs: '0000222' }];
    const [t] = (await staffing.sessionStaff(L, WED)).tournaments;
    expect(t!.organizer).toMatchObject({ playerId: '0000222', connected: false });
    expect(t!.editable).toBe(false);
  });

  it('lists each professor once and reads each tournament once (human-scale)', async () => {
    upstream.addProfessor(CILAN);
    upstream.state.tournaments.push(
      tournament('cilans-1', { organizer: '0000333', startsAt: new Date('2026-10-14T17:00:00Z') }),
      tournament('cilans-2', { organizer: '0000333', startsAt: new Date('2026-10-14T18:00:00Z') }),
    );
    await staffing.sessionStaff(L, WED);
    const count = (prefix: string) => upstream.state.calls.filter((c) => c.startsWith(prefix)).length;
    expect(count('listTournaments')).toBe(3);
    expect(count('getTournament')).toBe(4);
    expect(count('listTournamentParticipants')).toBe(4);
    expect(upstream.maxConcurrentCalls()).toBe(1);
  });
});

// #115: the day as an integration sees it. A professor is read only when every call for them succeeded,
// so a consumer can tell a cancelled tournament from one whose organizer couldn't be read.
describe('daySnapshot', () => {
  const WED = '2026-10-14' as SessionDate;
  const BROCK = { id: 2, professorPlayerId: '0000222', professorName: 'Brock Harrison' };
  const assign = (row: { tournamentId: string; playerId: string; role?: string; state?: string; removedAt?: number }) =>
    database.sqlite
      .prepare(
        `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, state, removed_at, created_by, created_at)
         values (?, ?, ?, 'Stored label', ?, ?, ?, ?, 'organizer', 0)`,
      )
      .run(L, WED, row.tournamentId, row.playerId, row.role ?? 'judge', row.removedAt ? 'removing' : (row.state ?? 'pending'), row.removedAt ?? null);

  beforeEach(() => {
    upstream.addProfessor(BROCK);
    roster.ensurePlayers(L, [{ playerId: id('00123'), name: 'Ash' }, { playerId: id('00456'), name: 'Misty' }, { playerId: id('00777'), name: 'Gone' }]);
    upstream.state.tournaments = [
      tournament('olives', { startsAt: new Date('2026-10-14T23:30:00Z'), name: 'Olive Cup', displayId: '26-10-000001' }),
      tournament('brocks', { startsAt: new Date('2026-10-14T22:00:00Z'), organizer: '0000222', name: null, displayId: null }),
      tournament('brocks-elsewhere', { startsAt: new Date('2026-10-14T21:00:00Z'), organizer: '0000222', groupId: 'another-store' }),
    ];
  });

  it("returns the read tournaments by start with their play-tools fields, organizer and live staff, and every professor read", async () => {
    assign({ tournamentId: 'olives', playerId: '00456', role: 'scorekeeper', state: 'assigned' });
    assign({ tournamentId: 'olives', playerId: '00123', role: 'judge', state: 'failed' });
    assign({ tournamentId: 'olives', playerId: '00777', role: 'judge', removedAt: 1 });
    upstream.state.participants.set('olives', [staffer('9999991', 'organizer'), staffer('00888', 'judge', 'Only Upstream')]);

    const day = await staffing.daySnapshot(L, WED);

    expect(day.timeZone).toBe(TZ);
    expect(day.tournaments.map((t) => [t.tournament.id, t.tournament.name, t.tournament.displayId, t.tournament.products, t.organizerPlayerId])).toEqual([
      ['brocks', null, null, ['tcg'], '0000222'],
      ['olives', 'Olive Cup', '26-10-000001', ['tcg'], '9999991'],
    ]);
    expect(day.tournaments[1]!.tournament.startsAt).toEqual(new Date('2026-10-14T23:30:00Z'));
    expect(day.tournaments[1]!.staff).toEqual([
      { playerId: '00456', name: 'Misty', role: 'scorekeeper' },
      { playerId: '00123', name: 'Ash', role: 'judge' },
    ]);
    expect(day.tournaments[0]!.staff).toEqual([]);
    expect(day.professors).toEqual([
      { connectionId: 1, outcome: { status: 'read' } },
      { connectionId: 2, outcome: { status: 'read' } },
    ]);
  });

  it('leaves out assignments on tournaments no read returned', async () => {
    assign({ tournamentId: 'cancelled', playerId: '00123' });
    const day = await staffing.daySnapshot(L, WED);
    expect(day.tournaments.map((t) => t.tournament.id)).toEqual(['brocks', 'olives']);
  });

  it('marks a professor who already needs a reconnect unread, without calling as them', async () => {
    upstream.addProfessor({ ...BROCK, status: 'needs_reconnect' });
    const day = await staffing.daySnapshot(L, WED);
    expect(day.tournaments.map((t) => t.tournament.id)).toEqual(['olives']);
    expect(day.professors).toEqual([
      { connectionId: 1, outcome: { status: 'read' } },
      { connectionId: 2, outcome: { status: 'unread', code: 'needs_reconnect' } },
    ]);
    expect(upstream.state.callsAs.filter((c) => c.as === 2)).toEqual([]);
  });

  it.each([
    ['their listing', 'listTournaments', 'unavailable'],
    ['a tournament’s details', 'getTournament', 'rate_limited'],
    ['a tournament’s participants', 'listTournamentParticipants', 'needs_reconnect'],
  ] as const)('drops all of a professor’s tournaments and marks them unread when %s fails', async (_l, method, code) => {
    upstream.state.tournaments.push(tournament('brocks-2', { startsAt: new Date('2026-10-14T20:00:00Z'), organizer: '0000222' }));
    // Fail the professor's last call, so a tournament of theirs was already read before it.
    let seen = 0;
    upstream.state.before = (call, as) => {
      if (as !== 2 || !call.startsWith(method)) return;
      if (method === 'listTournaments' || ++seen === 2) throw new PokemonUpstreamError(code, 'failed');
    };

    const day = await staffing.daySnapshot(L, WED);
    expect(day.tournaments.map((t) => t.tournament.id)).toEqual(['olives']);
    expect(day.professors).toEqual([
      { connectionId: 1, outcome: { status: 'read' } },
      { connectionId: 2, outcome: { status: 'unread', code } },
    ]);
  });

  it('skips a listed tournament play-tools no longer has, and the professor stays read', async () => {
    upstream.state.gone.add('brocks');
    const day = await staffing.daySnapshot(L, WED);
    expect(day.tournaments.map((t) => t.tournament.id)).toEqual(['olives']);
    expect(day.professors.map((p) => p.outcome.status)).toEqual(['read', 'read']);
  });

  it('returns a tournament two connections list once', async () => {
    upstream.addProfessor({ id: 4, professorPlayerId: null, upstreamAs: '9999991' });
    const day = await staffing.daySnapshot(L, WED);
    expect(day.tournaments.map((t) => t.tournament.id)).toEqual(['brocks', 'olives']);
    expect(day.professors.map((p) => p.connectionId)).toEqual([1, 2, 4]);
  });

  it('refuses before reading when no league is chosen', async () => {
    upstream.state.connection = { ...upstream.state.connection, league: null };
    await expect(staffing.daySnapshot(L, WED)).rejects.toEqual(expect.objectContaining({ code: 'league_not_selected' }));
    expect(upstream.state.calls).toEqual([]);
  });
});

describe('addAssignment', () => {
  const WED = '2026-10-14' as never;
  const add = (body: { tournamentId?: string; playerId: string; role?: string; name?: string }) =>
    staffing.addAssignment(L, WED, { tournamentId: 't-1', role: 'judge', ...body, playerId: id(body.playerId) }, OWNER);
  const rows = () => database.sqlite.prepare('select id, player_id, role, state, record_id, applied_role, removed_at from staff_assignment order by id').all();

  beforeEach(() => {
    upstream.addProfessor({ id: 1, professorPlayerId: '00777' });
    upstream.state.tournaments = [tournament('t-1', { name: 'League Challenge', displayId: '26-10-1', organizer: '00777' })];
    upstream.state.participants.set('t-1', [staffer('00777', 'organizer'), playing('00888')]);
  });

  it('adds a pending assignment for a first-time staffer and makes them known by the name given', async () => {
    const result = await add({ playerId: '00999', name: 'Brock' });

    expect(result).toEqual({
      created: true,
      assignment: { id: expect.any(Number), playerId: '00999', name: 'Brock', role: 'judge', appliedRole: null, state: 'pending' },
    });
    expect(database.sqlite.prepare('select session_date, tournament_id, tournament_label, created_by from staff_assignment').get()).toEqual({
      session_date: '2026-10-14',
      tournament_id: 't-1',
      tournament_label: 'League Challenge · 26-10-1',
      created_by: 'organizer',
    });
  });

  it('answers a repeat of the same add with the same assignment, without calling play-tools', async () => {
    const first = await add({ playerId: '00999' });
    upstream.state.calls.length = 0;
    const again = await add({ playerId: '00999' });
    expect(again).toEqual({ created: false, assignment: first.assignment });
    expect(upstream.state.calls).toEqual([]);
  });

  it('keeps one role per player on a tournament', async () => {
    await add({ playerId: '00999', role: 'judge' });
    await expect(add({ playerId: '00999', role: 'scorekeeper' })).rejects.toEqual(expect.objectContaining({ code: 'player_already_staffed' }));
  });

  it.each(['organizer', 'wizard', ''])('refuses the role %j before calling play-tools', async (role) => {
    await expect(add({ playerId: '00999', role })).rejects.toEqual(expect.objectContaining({ code: 'unknown_role' }));
    expect(upstream.state.calls).toEqual([]);
  });

  it("refuses the tournament's organizer, checked against a fresh read, and writes nothing", async () => {
    await expect(add({ playerId: '00777' })).rejects.toEqual(expect.objectContaining({ code: 'organizer_cannot_staff' }));
    expect(upstream.state.calls).toContain('getTournament t-1');
    expect(rows()).toEqual([]);
  });

  it('lets the organizer of one tournament staff another one', async () => {
    upstream.addProfessor({ id: 2, professorPlayerId: '00999' });
    upstream.state.tournaments.push(tournament('t-2', { organizer: '00999' }));
    await expect(add({ tournamentId: 't-1', playerId: '00999' })).resolves.toMatchObject({ created: true });
  });

  it('refuses someone play-tools already lists on the tournament, saying how', async () => {
    upstream.state.participants.get('t-1')!.push(staffer('00555', 'judge'));
    await expect(add({ playerId: '00888' })).rejects.toEqual(expect.objectContaining({ code: 'already_listed', details: { how: 'player' } }));
    await expect(add({ playerId: '00555' })).rejects.toEqual(expect.objectContaining({ code: 'already_listed', details: { how: 'staff' } }));
    expect(rows()).toEqual([]);
  });

  it.each([
    ['not on that date', () => upstream.state.tournaments.splice(0, 1, tournament('t-1', { startsAt: new Date('2026-10-21T23:30:00Z') }))],
    ["another league's", () => upstream.state.tournaments.splice(0, 1, tournament('t-1', { groupId: 'another-store' }))],
    ['deleted after it was listed', () => upstream.state.gone.add('t-1')],
  ])('refuses a tournament %s as unknown_tournament', async (_why, arrange) => {
    arrange();
    await expect(add({ playerId: '00999' })).rejects.toEqual(expect.objectContaining({ code: 'unknown_tournament' }));
    expect(rows()).toEqual([]);
  });

  it('refuses a tournament past its edit window', async () => {
    upstream.state.tournaments = [tournament('t-1', { editableUntil: new Date('2026-10-01T00:00:00Z'), organizer: '00777' })];
    await expect(add({ playerId: '00999' })).rejects.toEqual(expect.objectContaining({ code: 'tournament_locked' }));
  });

  it('fails with the upstream error when play-tools cannot be read, and writes nothing', async () => {
    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('unavailable', 'down'));
    await expect(add({ playerId: '00999' })).rejects.toEqual(expect.objectContaining({ code: 'unavailable' }));
    expect(rows()).toEqual([]);
  });

  it('never renames a player the app already names', async () => {
    roster.ensurePlayers(L, [{ playerId: id('00999'), name: 'Brock' }]);
    expect((await add({ playerId: '00999', name: 'Someone Else' })).assignment.name).toBe('Brock');
  });

  it('treats 00123 and 123 as different players', async () => {
    await add({ playerId: '00123', role: 'judge' });
    await expect(add({ playerId: '123', role: 'scorekeeper' })).resolves.toMatchObject({ created: true });
  });

  it('seeds the staff list from the participants it read', async () => {
    upstream.state.participants.get('t-1')!.push(staffer('00555', 'judge', 'Some Judge'));
    await add({ playerId: '00999' });
    expect(staffing.searchStaff(L, {}).map((s) => s.playerId)).toEqual(['00555']);
  });

  describe('after removing an applied assignment', () => {
    let original: number;
    beforeEach(async () => {
      original = (await add({ playerId: '00999', role: 'judge' })).assignment.id;
      database.sqlite.prepare("update staff_assignment set state = 'assigned', record_id = 'rec-ours', removed_at = 1").run();
      upstream.state.participants.get('t-1')!.push(staffer('00999', 'judge', '', 'rec-ours'));
    });

    it('revives that assignment instead of adding a second one, noting the role play-tools still holds', async () => {
      const result = await add({ playerId: '00999', role: 'scorekeeper' });
      expect(result).toEqual({ created: true, assignment: expect.objectContaining({ id: original, role: 'scorekeeper', appliedRole: 'judge', state: 'assigned' }) });
      expect(rows()).toEqual([
        { id: original, player_id: '00999', role: 'scorekeeper', state: 'assigned', record_id: 'rec-ours', applied_role: 'judge', removed_at: null },
      ]);
    });

    it('needs no role change when revived in the role play-tools holds', async () => {
      expect((await add({ playerId: '00999', role: 'judge' })).assignment).toMatchObject({ appliedRole: null, state: 'assigned' });
    });

    it('still refuses the revive on a locked tournament', async () => {
      upstream.state.tournaments = [tournament('t-1', { editableUntil: new Date('2026-10-01T00:00:00Z'), organizer: '00777' })];
      await expect(add({ playerId: '00999' })).rejects.toEqual(expect.objectContaining({ code: 'tournament_locked' }));
    });
  });
});

describe('changing and removing an assignment', () => {
  const WED = '2026-10-14' as never;
  const add = async (playerId: string, role = 'judge') =>
    (await staffing.addAssignment(L, WED, { tournamentId: 't-1', playerId: id(playerId), role }, OWNER)).assignment.id;
  const applyAs = (assignmentId: number, recordId = 'rec-ours') =>
    database.sqlite.prepare("update staff_assignment set state = 'assigned', record_id = ? where id = ?").run(recordId, assignmentId);
  const row = (assignmentId: number) =>
    database.sqlite.prepare('select role, applied_role, state, removed_at from staff_assignment where id = ?').get(assignmentId);
  const lock = () => (upstream.state.tournaments = [tournament('t-1', { editableUntil: new Date('2026-10-01T00:00:00Z') })]);

  beforeEach(() => {
    upstream.state.tournaments = [tournament('t-1')];
  });

  describe('changeRole', () => {
    it('changes the role of an assignment that never reached play-tools, reading only who organizes it and writing nothing', async () => {
      const a = await add('00999');
      upstream.state.calls.length = 0;
      expect(await staffing.changeRole(L, WED, a, 'scorekeeper', OWNER)).toMatchObject({ role: 'scorekeeper', appliedRole: null, state: 'pending' });
      expect(upstream.state.calls.every((c) => c.startsWith('listTournaments') || c.startsWith('getTournament'))).toBe(true);
      expect(upstream.state.writes).toEqual([]);
    });

    it('remembers the role play-tools holds for an applied assignment, and forgets it when changed back', async () => {
      const a = await add('00999');
      applyAs(a);
      expect(await staffing.changeRole(L, WED, a, 'scorekeeper', OWNER)).toMatchObject({ role: 'scorekeeper', appliedRole: 'judge' });
      expect(await staffing.changeRole(L, WED, a, 'headjudge', OWNER)).toMatchObject({ role: 'headjudge', appliedRole: 'judge' });
      expect(await staffing.changeRole(L, WED, a, 'judge', OWNER)).toMatchObject({ role: 'judge', appliedRole: null });
      expect(upstream.state.calls.filter((c) => !c.startsWith('listTournaments') && !c.startsWith('getTournament') && !c.startsWith('listTournamentParticipants'))).toEqual([]);
    });

    it('answers the same role with the assignment unchanged', async () => {
      const a = await add('00999');
      expect(await staffing.changeRole(L, WED, a, 'judge', OWNER)).toMatchObject({ id: a, role: 'judge' });
    });

    it('refuses a role play-tools does not offer', async () => {
      const a = await add('00999');
      await expect(staffing.changeRole(L, WED, a, 'organizer', OWNER)).rejects.toEqual(expect.objectContaining({ code: 'unknown_role' }));
    });

    it('refuses to change an applied assignment on a locked tournament', async () => {
      const a = await add('00999');
      applyAs(a);
      lock();
      await expect(staffing.changeRole(L, WED, a, 'scorekeeper', OWNER)).rejects.toEqual(expect.objectContaining({ code: 'tournament_locked' }));
      expect(row(a)).toMatchObject({ role: 'judge' });
    });

    it('is not_found for an unknown id, another date, or a removed assignment', async () => {
      const a = await add('00999');
      await expect(staffing.changeRole(L, WED, a + 100, 'scorekeeper', OWNER)).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
      await expect(staffing.changeRole(L, '2026-10-21' as never, a, 'scorekeeper', OWNER)).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
      applyAs(a);
      await staffing.removeAssignment(L, WED, a, OWNER);
      await expect(staffing.changeRole(L, WED, a, 'scorekeeper', OWNER)).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
    });
  });

  describe('removeAssignment', () => {
    it('deletes an assignment that never reached play-tools, reading only who organizes it and writing nothing', async () => {
      const a = await add('00999');
      upstream.state.calls.length = 0;
      await staffing.removeAssignment(L, WED, a, OWNER);
      expect(row(a)).toBeUndefined();
      expect(upstream.state.calls.every((c) => c.startsWith('listTournaments') || c.startsWith('getTournament'))).toBe(true);
      expect(upstream.state.writes).toEqual([]);
      await expect(staffing.removeAssignment(L, WED, a, OWNER)).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
    });

    it('tombstones an applied assignment for the staff job to delete upstream, sending nothing itself', async () => {
      const a = await add('00999');
      applyAs(a);
      await staffing.removeAssignment(L, WED, a, OWNER);
      expect(row(a)).toMatchObject({ state: 'removing', removed_at: expect.any(Number) });
      expect((await staffing.sessionStaff(L, WED)).tournaments[0]!.assignments).toEqual([expect.objectContaining({ id: a, state: 'removing' })]);
    });

    it('refuses to remove an applied assignment on a locked tournament', async () => {
      const a = await add('00999');
      applyAs(a);
      lock();
      await expect(staffing.removeAssignment(L, WED, a, OWNER)).rejects.toEqual(expect.objectContaining({ code: 'tournament_locked' }));
      expect(row(a)).toMatchObject({ removed_at: null });
    });

    it('refuses to tombstone an applied assignment once nobody can read its tournament, since its organizer is unknown', async () => {
      const a = await add('00999');
      applyAs(a);
      upstream.state.tournaments = [];
      await expect(staffing.removeAssignment(L, WED, a, OWNER)).rejects.toMatchObject({ code: 'not_your_connection' });
      expect(row(a)).toMatchObject({ state: 'assigned' });
    });

    it('is not_found for an assignment of another date', async () => {
      const a = await add('00999');
      await expect(staffing.removeAssignment(L, '2026-10-21' as never, a, OWNER)).rejects.toEqual(expect.objectContaining({ code: 'not_found' }));
    });
  });
});

describe('listRoles', () => {
  it("offers play-tools' staff roles in its order, judge first, never organizer, without calling it", () => {
    const roles = staffing.listRoles(L);
    expect(roles.map((r) => r.code)).toEqual(['judge', 'headjudge', 'scorekeeper', 'administration', 'translator']);
    expect(upstream.state.calls).toEqual([]);
  });
});

describe('what a staff job reads and writes back (#47)', () => {
  const DATE = '2026-10-14' as SessionDate;
  const row = (sql: string) => database.sqlite.prepare(sql).get();

  async function want(playerId: string, role = 'judge') {
    const { assignment } = await staffing.addAssignment(L, DATE, { tournamentId: 't-1', playerId: id(playerId), role }, OWNER);
    return assignment.id;
  }

  beforeEach(() => {
    upstream.state.tournaments = [tournament('t-1', { name: 'League Challenge', displayId: '26-10-1' })];
  });

  describe('prepareApply', () => {
    it("returns one of the date's tournaments with its label, read fresh", async () => {
      await want('00123');
      upstream.state.calls = [];

      expect(await staffing.prepareApply(L, DATE, 't-1', OWNER)).toEqual({
        tournamentId: 't-1',
        label: 'League Challenge · 26-10-1',
        professor: { connectionId: 1, playerId: '9999991', name: 'Olive Organizer' },
      });
      expect(upstream.state.calls).toContain(`listTournaments ${new Date('2026-10-14T05:00:00Z').toISOString()}`);
    });

    it('refuses a tournament that is not one of this league’s on the date', async () => {
      await want('00123');
      upstream.state.tournaments.push(tournament('t-other', { groupId: 'another-store' }));
      await expect(staffing.prepareApply(L, DATE, 't-other', OWNER)).rejects.toMatchObject({ code: 'unknown_tournament' });
      await expect(staffing.prepareApply(L, DATE, 't-nope', OWNER)).rejects.toMatchObject({ code: 'unknown_tournament' });
    });

    it('refuses a tournament past its edit window', async () => {
      await want('00123');
      upstream.state.tournaments = [tournament('t-1', { editableUntil: new Date(NOW.getTime() - 1) })];
      await expect(staffing.prepareApply(L, DATE, 't-1', OWNER)).rejects.toMatchObject({ code: 'tournament_locked' });
    });

    it('refuses a tournament with no assignments at all', async () => {
      await expect(staffing.prepareApply(L, DATE, 't-1', OWNER)).rejects.toMatchObject({ code: 'nothing_to_apply' });
    });

    it('still applies a tournament whose only assignment is tombstoned (it has a removal to send)', async () => {
      const a = await want('00123');
      staffing.recordApplied(L, a, { recordId: 'rec-1', role: 'judge' });
      await staffing.removeAssignment(L, DATE, a, OWNER);
      await expect(staffing.prepareApply(L, DATE, 't-1', OWNER)).resolves.toMatchObject({ tournamentId: 't-1' });
    });

    it('refuses an active assignment holding a role play-tools does not offer (organizer included)', async () => {
      const a = await want('00123');
      database.sqlite.prepare("update staff_assignment set role = 'organizer' where id = ?").run(a);
      await expect(staffing.prepareApply(L, DATE, 't-1', OWNER)).rejects.toMatchObject({ code: 'unknown_role' });
    });

    it('refuses before a league is chosen', async () => {
      upstream.state.connection = { ...upstream.state.connection, league: null };
      await expect(staffing.prepareApply(L, DATE, 't-1', OWNER)).rejects.toMatchObject({ code: 'league_not_selected' });
    });
  });

  describe('assignmentsFor', () => {
    it("lists the tournament's live and tombstoned assignments with the record this app holds", async () => {
      const a = await want('00123');
      const b = await want('00456', 'scorekeeper');
      staffing.recordApplied(L, b, { recordId: 'rec-b', role: 'scorekeeper' });
      await staffing.removeAssignment(L, DATE, b, OWNER);

      expect(staffing.assignmentsFor(L, 't-1')).toEqual([
        { id: a, playerId: '00123', role: 'judge', appliedRole: null, recordId: null, removed: false },
        { id: b, playerId: '00456', role: 'scorekeeper', appliedRole: null, recordId: 'rec-b', removed: true },
      ]);
      expect(staffing.assignmentsFor(L, 't-other')).toEqual([]);
    });
  });

  describe('recordApplied', () => {
    it('marks the assignment assigned with its record, and puts the staffer on the staff list as the app’s', async () => {
      const a = await want('00123');

      staffing.recordApplied(L, a, { recordId: 'rec-1', role: 'judge' });

      expect(row(`select state, record_id, applied_role, assigned_at from staff_assignment where id = ${a}`)).toEqual({
        state: 'assigned',
        record_id: 'rec-1',
        applied_role: null,
        assigned_at: Math.floor(NOW.getTime() / 1000),
      });
      expect(history()).toContainEqual({ tournament_id: 't-1', player_id: '00123', tournament_date: DATE, role: 'judge', source: 'app' });
    });

    it('keeps when the assignment first reached play-tools, and updates the staff list role on a role change', async () => {
      const a = await want('00123');
      staffing.recordApplied(L, a, { recordId: 'rec-1', role: 'judge' });
      database.sqlite.prepare(`update staff_assignment set assigned_at = 1, role = 'scorekeeper', applied_role = 'judge' where id = ${a}`).run();

      staffing.recordApplied(L, a, { recordId: 'rec-1', role: 'scorekeeper' });

      expect(row(`select assigned_at, applied_role from staff_assignment where id = ${a}`)).toEqual({ assigned_at: 1, applied_role: null });
      expect(history()).toContainEqual(expect.objectContaining({ player_id: '00123', role: 'scorekeeper', source: 'app' }));
    });

    it('remembers the role play-tools now holds when the organizer changed it while the job ran', async () => {
      const a = await want('00123');
      database.sqlite.prepare(`update staff_assignment set role = 'scorekeeper' where id = ${a}`).run();

      staffing.recordApplied(L, a, { recordId: 'rec-1', role: 'judge' });

      expect(row(`select role, applied_role, state from staff_assignment where id = ${a}`)).toEqual({
        role: 'scorekeeper',
        applied_role: 'judge',
        state: 'assigned',
      });
    });

    it('is a no-op for an assignment deleted while the job ran', async () => {
      const a = await want('00123');
      await staffing.removeAssignment(L, DATE, a, OWNER);
      expect(() => staffing.recordApplied(L, a, { recordId: 'rec-1', role: 'judge' })).not.toThrow();
      expect(row('select count(*) n from staff_assignment')).toEqual({ n: 0 });
    });
  });

  describe('recordFailed', () => {
    it('marks a live assignment failed, and leaves a tombstoned one alone', async () => {
      const a = await want('00123');
      staffing.recordFailed(L, a);
      expect(row(`select state from staff_assignment where id = ${a}`)).toEqual({ state: 'failed' });

      staffing.recordApplied(L, a, { recordId: 'rec-1', role: 'judge' });
      await staffing.removeAssignment(L, DATE, a, OWNER);
      staffing.recordFailed(L, a);
      expect(row(`select state from staff_assignment where id = ${a}`)).toEqual({ state: 'removing' });
    });
  });

  describe('forgetRemoved', () => {
    it('deletes a tombstoned assignment and keeps the staff list', async () => {
      const a = await want('00123');
      staffing.recordApplied(L, a, { recordId: 'rec-1', role: 'judge' });
      await staffing.removeAssignment(L, DATE, a, OWNER);

      staffing.forgetRemoved(L, a);

      expect(row('select count(*) n from staff_assignment')).toEqual({ n: 0 });
      expect(history()).toContainEqual(expect.objectContaining({ player_id: '00123', source: 'app' }));
    });

    it('never deletes a live assignment (the organizer revived it while the job ran)', async () => {
      const a = await want('00123');
      staffing.forgetRemoved(L, a);
      expect(row('select count(*) n from staff_assignment')).toEqual({ n: 1 });
    });
  });
});

describe('acting on a tournament as its organizer (#75)', () => {
  const WED = '2026-10-14' as SessionDate;
  const BROCK = { id: 2, professorPlayerId: '0000222', professorName: 'Brock Harrison' };
  const add = (tournamentId: string, playerId = '00555') =>
    staffing.addAssignment(L, WED, { tournamentId, playerId: id(playerId), role: 'judge' }, OWNER);
  const stored = () => database.sqlite.prepare('select count(*) n from staff_assignment').get();

  beforeEach(() => {
    upstream.addProfessor(BROCK);
    upstream.state.tournaments = [tournament('olives'), tournament('brocks', { organizer: '0000222', name: 'Brock Cup', displayId: null })];
    upstream.state.participants.set('brocks', [staffer('0000222', 'organizer')]);
  });

  it("adds staff to another professor's tournament, reading it fresh as that professor", async () => {
    upstream.state.callsAs = [];
    await add('brocks');
    expect(upstream.state.callsAs.filter((c) => c.call.endsWith(' brocks')).map((c) => c.as)).toEqual([2, 2]);
    expect(stored()).toEqual({ n: 1 });
  });

  it("prepares a staff job on another professor's tournament as that professor", async () => {
    await add('brocks');
    expect(await staffing.prepareApply(L, WED, 'brocks', OWNER)).toEqual({
      tournamentId: 'brocks',
      label: 'Brock Cup',
      professor: { connectionId: 2, playerId: '0000222', name: 'Brock Harrison' },
    });
  });

  it('acts as whoever organizes the tournament now, read fresh', async () => {
    await add('brocks');
    upstream.state.tournaments = [tournament('brocks', { organizer: '9999991', name: 'Brock Cup', displayId: null })];
    expect((await staffing.prepareApply(L, WED, 'brocks', OWNER)).professor).toEqual({ connectionId: 1, playerId: '9999991', name: 'Olive Organizer' });
  });

  it('refuses with organizer_not_connected when no connected professor organizes it, storing nothing', async () => {
    upstream.state.professors = [{ ...OLIVE }, { id: 5, professorPlayerId: null, professorName: null, status: 'connected', ...HELD_BY_OWNER, upstreamAs: '0000222' }];
    await expect(add('brocks')).rejects.toMatchObject({ name: 'StaffingError', code: 'organizer_not_connected', details: { organizerPlayerId: '0000222' } });
    expect(stored()).toEqual({ n: 0 });
  });

  it('refuses with organizer_not_connected when the organizer disconnected after the card loaded', async () => {
    upstream.state.professors = [{ ...OLIVE }];
    await expect(add('brocks')).rejects.toMatchObject({ code: 'organizer_not_connected', details: { organizerPlayerId: '0000222' } });
    expect(stored()).toEqual({ n: 0 });
  });

  it("refuses with needs_reconnect naming the organizer when their login needs a reconnect, never acting through another professor", async () => {
    await add('brocks');
    upstream.addProfessor({ ...BROCK, status: 'needs_reconnect' });
    upstream.state.callsAs = [];

    await expect(staffing.prepareApply(L, WED, 'brocks', OWNER)).rejects.toMatchObject({ code: 'needs_reconnect', details: { professorPlayerId: '0000222' } });
    await expect(add('brocks', '00556')).rejects.toMatchObject({ code: 'needs_reconnect', details: { professorPlayerId: '0000222' } });
    expect(upstream.state.callsAs.filter((c) => c.call === 'listTournamentParticipants brocks')).toEqual([]);
  });

  it('still answers unknown_tournament for a tournament nobody has on the date', async () => {
    await expect(add('nope')).rejects.toMatchObject({ code: 'unknown_tournament' });
  });

  it("lets the owner delete a pending assignment after its organizer disconnected, without play-tools, but not change its role", async () => {
    const { assignment } = await add('brocks');
    upstream.state.professors = [];
    upstream.state.calls = [];

    await expect(staffing.changeRole(L, WED, assignment.id, 'scorekeeper', OWNER)).rejects.toMatchObject({ code: 'not_your_connection' });
    await staffing.removeAssignment(L, WED, assignment.id, OWNER);
    expect(stored()).toEqual({ n: 0 });
    expect(upstream.state.calls).toEqual([]);
  });

  it('checks an applied change against the tournament as its organizer', async () => {
    const { assignment } = await add('brocks');
    staffing.recordApplied(L, assignment.id, { recordId: 'rec-1', role: 'judge' });
    upstream.state.callsAs = [];
    await staffing.changeRole(L, WED, assignment.id, 'scorekeeper', OWNER);
    const aboutBrocks = upstream.state.callsAs.filter((c) => c.call.endsWith(' brocks'));
    expect(aboutBrocks.length).toBeGreaterThan(0);
    expect(aboutBrocks.map((c) => c.as)).not.toContain(1);
  });
});

describe('moveTournament: a rescheduled tournament keeps its staff (ADR-0010 decision 8)', () => {
  const insert = (tournamentId: string, playerId: string, date: string, removedAt: number | null = null) =>
    database.sqlite
      .prepare(
        `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, created_by, created_at, removed_at)
         values (?, ?, ?, 'Cup', ?, 'judge', 'organizer', 0, ?)`,
      )
      .run(L, date, tournamentId, playerId, removedAt);
  const dates = () =>
    database.sqlite.prepare('select tournament_id, player_id, session_date from staff_assignment order by tournament_id, player_id').all();

  it("moves every assignment of that tournament, tombstones too, and nobody else's", () => {
    database.sqlite.prepare("insert into player (player_id, display_name, first_seen_at) values ('00456', 'Misty', 0)").run();
    insert('t-1', '00123', '2026-10-20');
    insert('t-1', '00456', '2026-10-20', 1);
    insert('t-2', '00123', '2026-10-20');

    expect(staffing.moveTournament(L, 't-1', '2026-10-22' as SessionDate)).toBe(2);
    expect(dates()).toEqual([
      { tournament_id: 't-1', player_id: '00123', session_date: '2026-10-22' },
      { tournament_id: 't-1', player_id: '00456', session_date: '2026-10-22' },
      { tournament_id: 't-2', player_id: '00123', session_date: '2026-10-20' },
    ]);
  });

  it("leaves another league's assignments alone", () => {
    expect(staffing.moveTournament('other-league', 't-1', '2026-10-22' as SessionDate)).toBe(0);
  });
});

describe('cancelTournament: a cancelled tournament keeps no wanted staff (ADR-0010 decision 8)', () => {
  const insert = (tournamentId: string, playerId: string, set: { state?: string; recordId?: string | null; removedAt?: number | null } = {}) =>
    database.sqlite
      .prepare(
        `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, state, record_id, created_by, created_at, removed_at)
         values (?, '2026-10-20', ?, 'Cup', ?, 'judge', ?, ?, 'organizer', 0, ?)`,
      )
      .run(L, tournamentId, playerId, set.state ?? 'pending', set.recordId ?? null, set.removedAt ?? null);
  const rows = () =>
    database.sqlite
      .prepare('select tournament_id, player_id, state, record_id, removed_at from staff_assignment order by tournament_id, player_id')
      .all();

  beforeEach(() => {
    for (const [id, name] of [
      ['00456', 'Misty'],
      ['00789', 'Brock'],
      ['00999', 'Gary'],
    ]) {
      database.sqlite.prepare('insert into player (player_id, display_name, first_seen_at) values (?, ?, 0)').run(id, name);
    }
  });

  it('drops what never reached play-tools, tombstones what did, and keeps an existing tombstone as it was', () => {
    insert('t-1', '00123'); // pending, never sent
    insert('t-1', '00456', { state: 'failed' }); // never reached play-tools
    insert('t-1', '00789', { state: 'assigned', recordId: 'rec-789' });
    insert('t-1', '00999', { state: 'removing', recordId: 'rec-999', removedAt: 5 });
    insert('t-2', '00123', { state: 'assigned', recordId: 'rec-x' });

    expect(staffing.cancelTournament(L, 't-1')).toEqual({ dropped: 2, removed: 1 });

    expect(rows()).toEqual([
      { tournament_id: 't-1', player_id: '00789', state: 'removing', record_id: 'rec-789', removed_at: Math.floor(NOW.getTime() / 1000) },
      { tournament_id: 't-1', player_id: '00999', state: 'removing', record_id: 'rec-999', removed_at: 5 },
      { tournament_id: 't-2', player_id: '00123', state: 'assigned', record_id: 'rec-x', removed_at: null },
    ]);
  });

  it('changes nothing the second time, and nothing of another league', () => {
    insert('t-1', '00789', { state: 'assigned', recordId: 'rec-789' });
    staffing.cancelTournament(L, 't-1');
    const after = rows();
    expect(staffing.cancelTournament(L, 't-1')).toEqual({ dropped: 0, removed: 0 });
    expect(staffing.cancelTournament('other-league', 't-1')).toEqual({ dropped: 0, removed: 0 });
    expect(rows()).toEqual(after);
  });
});

describe('forgetPlayed: a staffer who played, removed from staff on request (ADR-0007 update, #96)', () => {
  const assign = (tournamentId: string, playerId: string, set: { recordId?: string | null; removedAt?: number | null } = {}) =>
    database.sqlite
      .prepare(
        `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, state, record_id, created_by, created_at, removed_at)
         values (?, '2026-10-20', ?, 'Cup', ?, 'judge', 'assigned', ?, 'organizer', 0, ?)`,
      )
      .run(L, tournamentId, playerId, set.recordId ?? null, set.removedAt ?? null);
  const history = (tournamentId: string, playerId: string) =>
    database.sqlite
      .prepare(`insert into staff_history (league_id, tournament_id, player_id, role, source, recorded_at) values (?, ?, ?, 'judge', 'upstream', 0)`)
      .run(L, tournamentId, playerId);
  const left = (table: string) => database.sqlite.prepare(`select tournament_id, player_id from ${table} order by tournament_id, player_id`).all();

  beforeEach(() => {
    for (const id of ['00123', '00456']) database.sqlite.prepare("insert or ignore into player (player_id, display_name, first_seen_at) values (?, 'P', 0)").run(id);
  });

  it("drops the player's assignments (live and tombstoned) and staff-list row for that tournament only", () => {
    assign('t-1', '00123', { recordId: 'rec-1' });
    assign('t-1', '00123', { recordId: 'rec-0', removedAt: 5 });
    assign('t-1', '00456', { recordId: 'rec-2' });
    assign('t-2', '00123', { recordId: 'rec-3' });
    history('t-1', '00123');
    history('t-1', '00456');
    history('t-2', '00123');

    expect(staffing.forgetPlayed(L, 't-1', '00123' as PlayerId)).toEqual({ assignments: 2, history: 1 });

    expect(left('staff_assignment')).toEqual([
      { tournament_id: 't-1', player_id: '00456' },
      { tournament_id: 't-2', player_id: '00123' },
    ]);
    expect(left('staff_history')).toEqual([
      { tournament_id: 't-1', player_id: '00456' },
      { tournament_id: 't-2', player_id: '00123' },
    ]);
  });

  it('is a no-op for nobody, and for another league', () => {
    assign('t-1', '00123', { recordId: 'rec-1' });
    expect(staffing.forgetPlayed(L, 't-1', '00456' as PlayerId)).toEqual({ assignments: 0, history: 0 });
    expect(staffing.forgetPlayed('other-league', 't-1', '00123' as PlayerId)).toEqual({ assignments: 0, history: 0 });
    expect(left('staff_assignment')).toHaveLength(1);
  });
});

describe('who may change a tournament\'s staff (ADR-0015 §4)', () => {
  const WED = '2026-10-14' as SessionDate;
  const MISTY = professorActor(2, 'misty');
  const MISTYS = { id: 3, professorPlayerId: '0000333', professorName: 'Misty', userId: MISTY.userId };
  const stored = () => database.sqlite.prepare('select count(*) n from staff_assignment').get();
  const add = (actor = OWNER, tournamentId = 'olives', playerId = '00555') =>
    staffing.addAssignment(L, WED, { tournamentId, playerId: id(playerId), role: 'judge' }, actor);

  beforeEach(() => {
    upstream.addProfessor(MISTYS);
    upstream.state.tournaments = [tournament('olives'), tournament('mistys', { organizer: '0000333', name: 'Misty Cup', displayId: null })];
    upstream.state.participants.set('mistys', [staffer('0000333', 'organizer')]);
  });

  it("refuses a professor staff changes on the owner's tournament, naming its organizer, writing nothing", async () => {
    const { assignment } = await add();
    upstream.state.writes = [];

    await expect(add(MISTY, 'olives', '00556')).rejects.toMatchObject({ code: 'not_your_connection', details: { professorPlayerId: '9999991' } });
    await expect(staffing.changeRole(L, WED, assignment.id, 'scorekeeper', MISTY)).rejects.toMatchObject({ code: 'not_your_connection' });
    await expect(staffing.removeAssignment(L, WED, assignment.id, MISTY)).rejects.toMatchObject({ code: 'not_your_connection' });
    await expect(staffing.prepareApply(L, WED, 'olives', MISTY)).rejects.toMatchObject({ code: 'not_your_connection' });
    expect(stored()).toEqual({ n: 1 });
  });

  it("refuses the owner staff changes on a professor's tournament", async () => {
    await expect(add(OWNER, 'mistys')).rejects.toMatchObject({ code: 'not_your_connection', details: { professorPlayerId: '0000333' } });
    expect(stored()).toEqual({ n: 0 });
  });

  it("lets the professor staff their own tournament, reading it as their connection", async () => {
    upstream.state.callsAs = [];
    await add(MISTY, 'mistys');
    expect(await staffing.prepareApply(L, WED, 'mistys', MISTY)).toMatchObject({ professor: { connectionId: 3, playerId: '0000333' } });
    expect(upstream.state.callsAs.filter((c) => c.call === 'listTournamentParticipants mistys').map((c) => c.as)).toEqual([3]);
  });

  it('lets only the owner delete a pending assignment of a tournament nobody can read any more', async () => {
    const { assignment } = await add(MISTY, 'mistys');
    upstream.state.tournaments = [tournament('olives')];

    await expect(staffing.removeAssignment(L, WED, assignment.id, MISTY)).rejects.toMatchObject({ code: 'not_your_connection' });
    await staffing.removeAssignment(L, WED, assignment.id, OWNER);
    expect(stored()).toEqual({ n: 0 });
  });

  it('never lets the owner delete a pending assignment whose organizer another user holds', async () => {
    const { assignment } = await add(MISTY, 'mistys');
    await expect(staffing.removeAssignment(L, WED, assignment.id, OWNER)).rejects.toMatchObject({ code: 'not_your_connection' });
  });

  it("doesn't read tournaments as a connection outside the league", async () => {
    upstream.addProfessor({ ...MISTYS, membership: 'outside' });
    upstream.state.callsAs = [];
    const view = await staffing.sessionStaff(L, WED);
    expect(view.tournaments.map((t) => t.tournamentId)).toEqual(['olives']);
    expect(upstream.state.callsAs.some((c) => c.as === 3)).toBe(false);
  });
});


describe('organizersOn (who organizes the date’s tournaments, for a batch’s first check)', () => {
  const WED = '2026-10-14' as SessionDate;

  it("maps each of the date's tournaments in the league to the professor whose listing has it, one listing per connection", async () => {
    upstream.addProfessor({ id: 2, professorPlayerId: '0000222', professorName: 'Brock' });
    upstream.state.tournaments = [
      tournament('olives'),
      tournament('brocks', { organizer: '0000222' }),
      tournament('elsewhere', { groupId: 'other-league' }),
    ];
    upstream.state.calls = [];

    expect(await staffing.organizersOn(L, WED)).toEqual(new Map([
      ['olives', '9999991'],
      ['brocks', '0000222'],
    ]));
    expect(upstream.state.calls.filter((c) => c.startsWith('listTournaments'))).toHaveLength(2);
    expect(upstream.state.calls.filter((c) => !c.startsWith('listTournaments'))).toEqual([]);
  });

  it('leaves out a professor whose listing fails; the turn reads it again', async () => {
    upstream.state.tournaments = [tournament('olives')];
    upstream.state.failNext.set('listTournaments', new PokemonUpstreamError('unavailable', 'down'));
    expect(await staffing.organizersOn(L, WED)).toEqual(new Map());
  });
});
