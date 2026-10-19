import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import { TournamentsError } from './errors';
import { type TournamentsService, createTournamentsService } from './service';
import { BROCK, GROUP, OLIVE, series, stubPlayTools, templateBody, upstreamTournament } from './test-helpers';
import { HELD_BY_OWNER, OWNER } from '../pokemon/test-connections';

// What Upcoming and the form options read from play-tools, as each professor (ADR-0010 decisions 6 and 10).

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
/** Wednesday 2026-10-14, noon in Chicago. */
const NOON_WED = new Date('2026-10-14T17:00:00Z');
const MINUTE = 60_000;

let database: OpenDatabase;
let upstream: ReturnType<typeof stubPlayTools>;
let service: TournamentsService;
let now: Date;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  upstream = stubPlayTools();
  upstream.state.professors.push({ ...BROCK });
  now = NOON_WED;
  service = createTournamentsService({ db: database.db, connections: upstream.connections, gateway: upstream.gateway, timeZone: TZ, now: () => now });
});
afterEach(() => database.close());

const link = (plannedId: number, tournamentId: string) =>
  database.sqlite.prepare("update planned_tournament set state = 'created', tournament_id = ?, display_id = ?, upstream_status = 'approval-pending' where id = ?").run(tournamentId, `26-10-${tournamentId}`, plannedId);

describe('Upcoming with play-tools’ tournaments', () => {
  it('merges a linked row with its tournament, lists the league’s others, and leaves out other leagues', async () => {
    const template = service.createTemplate(L, templateBody({ type: { kind: 'custom' }, startTime: '18:00' }), OWNER);
    const planned = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-20' });
    link(planned.plannedId!, 'g1');
    upstream.state.tournaments = [
      upstreamTournament('g1', '2026-10-20T23:00:00Z', { status: 'sanctioned' }),
      // Brock's, at 11:00 on Saturday the 17th in Chicago.
      upstreamTournament('g2', '2026-10-17T16:00:00Z', { organizer: BROCK.professorPlayerId!, name: 'Saturday Cup' }),
      upstreamTournament('g3', '2026-10-18T16:00:00Z', { groupId: 'another-store' }),
      upstreamTournament('undated', '2026-10-18T16:00:00Z', { startsAt: null }),
    ];

    const { tournaments, upstream: read, unread } = await service.upcoming(L, {});
    expect(read).toBe('read');
    expect(unread).toEqual([]);
    expect(tournaments.map((t) => [t.tournamentId, t.state])).toEqual([
      ['g2', 'upstream'],
      ['g1', 'created'],
    ]);
    expect(tournaments[0]).toEqual({
      plannedId: null,
      tournamentId: 'g2',
      scheduleId: null,
      slotPosition: null,
      occurrenceDate: null,
      templateId: null,
      name: 'Saturday Cup',
      localDate: '2026-10-17',
      startTime: '11:00',
      startsAt: '2026-10-17T16:00:00.000Z',
      sanctionBy: '2026-10-10',
      state: 'upstream',
      inSchedule: null,
      organizer: { playerId: BROCK.professorPlayerId, name: 'Brock', connected: true, needsReconnect: false },
      product: 'tcg',
      category: null,
      type: null,
      displayId: '26-10-g2',
      upstreamStatus: 'sanctioned',
      errorCode: null,
      lastAttemptAt: null,
      skippedWhileUnknown: false,
      tdfAvailable: false,
      actions: [],
    });
    expect(tournaments[1]).toMatchObject({ plannedId: planned.plannedId, displayId: '26-10-g1', upstreamStatus: 'sanctioned', actions: [] });
  });

  it('reads each connected professor once, over the whole range', async () => {
    await service.upcoming(L, { from: '2026-10-12', to: '2026-12-31' });
    expect(upstream.state.calls.sort()).toEqual(['listTournaments@1', 'listTournaments@2']);
  });

  it('names a professor whose read failed, and still shows everyone else and every planned row', async () => {
    const template = service.createTemplate(L, templateBody({ type: { kind: 'custom' } }), OWNER);
    service.createPlanned(L, { templateId: template.id, localDate: '2026-10-20' });
    upstream.state.tournaments = [upstreamTournament('g1', '2026-10-21T23:00:00Z')];
    upstream.state.failNext.set('listTournaments@2', new PokemonUpstreamError('unavailable', 'play-tools is down'));
    upstream.state.professors.push({ id: 3, professorPlayerId: '9999993', professorName: 'Misty', status: 'needs_reconnect', ...HELD_BY_OWNER });

    const result = await service.upcoming(L, {});
    expect(result.unread).toEqual([
      { professor: { playerId: BROCK.professorPlayerId, name: 'Brock' }, code: 'unavailable', message: 'play-tools is down' },
      { professor: { playerId: '9999993', name: 'Misty' }, code: 'needs_reconnect', message: expect.any(String) },
    ]);
    expect(result.tournaments.map((t) => t.tournamentId ?? t.plannedId)).toEqual([expect.any(Number), 'g1']);
    expect(upstream.state.calls).not.toContain('listTournaments@3');
  });

  it('with no professor connected, lists planned rows only and calls nobody', async () => {
    const template = service.createTemplate(L, templateBody({ type: { kind: 'custom' } }), OWNER);
    service.createPlanned(L, { templateId: template.id, localDate: '2026-10-20' });
    upstream.state.professors = [];
    const result = await service.upcoming(L, {});
    expect(result).toMatchObject({ upstream: 'not_connected', unread: [] });
    expect(result.tournaments).toHaveLength(1);
    expect(upstream.state.calls).toEqual([]);
  });

  it('with no league chosen, lists planned rows only', async () => {
    upstream.state.connection = { ...upstream.state.connection, league: null };
    const result = await service.upcoming(L, {});
    expect(result.upstream).toBe('league_not_selected');
    expect(upstream.state.calls).toEqual([]);
  });

  it('refuses a range that ends first or runs over 366 days', async () => {
    for (const range of [{ from: '2026-10-20', to: '2026-10-19' }, { from: '2026-01-01' }]) {
      const err = await service.upcoming(L, range).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TournamentsError);
      expect((err as TournamentsError).code).toBe('invalid_range');
    }
  });
});

describe('the listing cache on Upcoming (#98)', () => {
  const listings = () => upstream.state.calls.filter((c) => c.startsWith('listTournaments@'));
  const reset = () => (upstream.state.calls = []);

  it('reuses each professor’s listing for 5 minutes, and reads it again on refresh', async () => {
    upstream.state.tournaments = [upstreamTournament('g1', '2026-10-21T23:00:00Z')];
    await service.upcoming(L, {});
    reset();
    now = new Date(NOON_WED.getTime() + 5 * MINUTE - 1000);
    upstream.state.tournaments.push(upstreamTournament('g2', '2026-10-22T23:00:00Z'));
    expect((await service.upcoming(L, {})).tournaments.map((t) => t.tournamentId)).toEqual(['g1']);
    expect(listings()).toEqual([]);

    const fresh = await service.upcoming(L, { refresh: true });
    expect(fresh.tournaments.map((t) => t.tournamentId)).toEqual(['g1', 'g2']);
    expect(listings().sort()).toEqual(['listTournaments@1', 'listTournaments@2']);
  });

  it('reads again once a tournament job ends', async () => {
    await service.upcoming(L, {});
    reset();
    service.requiredEvents.listingsChanged();
    await service.upcoming(L, {});
    expect(listings()).toHaveLength(2);
  });

  it('never keeps a failed listing', async () => {
    upstream.state.failNext.set('listTournaments@2', new PokemonUpstreamError('unavailable', 'down'));
    expect((await service.upcoming(L, {})).unread).toHaveLength(1);
    reset();
    expect((await service.upcoming(L, {})).unread).toEqual([]);
    expect(listings()).toEqual(['listTournaments@2']);
  });

  it('lists live for a create-through preview, whatever is cached', async () => {
    const template = service.createTemplate(L, templateBody({ type: { kind: 'custom' } }), OWNER);
    const scaffold = service.createScaffold(L, { name: 'Fridays', slots: [{ templateId: template.id, dayOffset: 0, startTime: null }] });
    const schedule = service.createSchedule(L, { scaffoldId: scaffold.id, rule: { kind: 'weekly', weekday: 5, every: 1 }, startsOn: '2026-10-16', endsOn: null });
    await service.createThrough(L, schedule.id, '2026-11-30');
    reset();
    await service.createThrough(L, schedule.id, '2026-11-30');
    expect(listings()).toHaveLength(2);
  });
});

describe('Download TDF on Upcoming', () => {
  /** A results upload of the tournament, with an archived file unless `file` is false (deleted). */
  const resultsUpload = (tournamentId: string, state: string, file = true) => {
    let fileId: number | null = null;
    if (file) {
      fileId = Number(
        database.sqlite
          .prepare("insert into tdf_file (league_id, sha256, filename, byte_size, ciphertext, created_by, created_at) values (?, ?, 'r.tdf', 1, x'00', 'organizer', 0)")
          .run(L, `sha-${tournamentId}-${state}`).lastInsertRowid,
      );
    }
    database.sqlite
      .prepare("insert into tournament_result_upload (league_id, tournament_id, session_date, filename, tdf_file_id, sha256, player_count, state, created_at) values (?, ?, '2026-10-14', 'r.tdf', ?, 'sha', 1, ?, 0)")
      .run(L, tournamentId, fileId, state);
  };

  it('says which tournaments the app holds a results file for', async () => {
    const template = service.createTemplate(L, templateBody({ type: { kind: 'custom' }, startTime: '18:00' }), OWNER);
    const linked = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-20' });
    link(linked.plannedId!, 'g1');
    service.createPlanned(L, { templateId: template.id, localDate: '2026-10-21' });
    upstream.state.tournaments = [
      upstreamTournament('g1', '2026-10-20T23:00:00Z', { status: 'sanctioned' }),
      upstreamTournament('g2', '2026-10-17T16:00:00Z'),
      upstreamTournament('g3', '2026-10-18T16:00:00Z'),
    ];
    resultsUpload('g1', 'complete');
    resultsUpload('g2', 'complete', false);
    resultsUpload('g3', 'failed');
    const { tournaments } = await service.upcoming(L, {});

    expect(tournaments.map((t) => [t.tournamentId, t.tdfAvailable])).toEqual([
      ['g2', false],
      ['g3', false],
      ['g1', true],
      [null, false],
    ]);
  });
});

describe('series on Upcoming', () => {
  const NOV = series('lc-nov', 'League Challenge November 2026', '2026-11-01', '2026-11-30');
  const DEC = series('lc-dec', 'League Challenge December 2026', '2026-12-01', '2026-12-31');

  function premierRows(organizer = OLIVE.professorPlayerId!) {
    const template = service.createTemplate(L, templateBody({ organizerPlayerId: organizer as never }), OWNER);
    const nov = service.createPlanned(L, { templateId: template.id, localDate: '2026-11-17' });
    const jan = service.createPlanned(L, { templateId: template.id, localDate: '2027-01-19' });
    return { template, nov, jan };
  }

  it('resolves each planned date to its series, with one listSeries per organizer', async () => {
    upstream.state.series = [NOV, DEC];
    const { nov, jan } = premierRows();
    const { tournaments } = await service.upcoming(L, { from: '2026-10-12', to: '2027-02-01' });
    expect(tournaments.find((t) => t.plannedId === nov.plannedId)).toMatchObject({
      type: { kind: 'premier', status: 'resolved', series: { id: 'lc-nov' } },
      actions: ['create', 'skip'],
    });
    expect(tournaments.find((t) => t.plannedId === jan.plannedId)).toMatchObject({
      type: { kind: 'premier', status: 'series_not_found' },
      actions: ['skip'],
    });
    expect(upstream.state.calls.filter((c) => c.startsWith('listSeries'))).toEqual(['listSeries@1']);
  });

  it('reads series again only after 10 minutes', async () => {
    premierRows();
    await service.upcoming(L, {});
    now = new Date(NOON_WED.getTime() + 10 * MINUTE - 1);
    await service.upcoming(L, {});
    expect(upstream.state.calls.filter((c) => c.startsWith('listSeries'))).toHaveLength(1);
    now = new Date(NOON_WED.getTime() + 10 * MINUTE);
    await service.upcoming(L, {});
    expect(upstream.state.calls.filter((c) => c.startsWith('listSeries'))).toHaveLength(2);
  });

  it('shows the type unavailable when the series couldn’t be read, and doesn’t keep the failure', async () => {
    const { nov } = premierRows();
    upstream.state.series = [NOV];
    upstream.state.failNext.set('listSeries', new PokemonUpstreamError('unavailable', 'down'));
    const first = await service.upcoming(L, {});
    expect(first.tournaments.find((t) => t.plannedId === nov.plannedId)).toMatchObject({ type: { kind: 'premier', status: 'unavailable', candidates: [] }, actions: ['skip'] });
    const second = await service.upcoming(L, {});
    expect(second.tournaments.find((t) => t.plannedId === nov.plannedId)?.type).toMatchObject({ status: 'resolved' });
  });

  it('shows the type unavailable, with no create, for an organizer who isn’t connected any more', async () => {
    upstream.state.series = [NOV];
    const { nov } = premierRows(BROCK.professorPlayerId!);
    upstream.state.professors = upstream.state.professors.filter((p) => p.id !== BROCK.id);
    const entry = (await service.upcoming(L, {})).tournaments.find((t) => t.plannedId === nov.plannedId)!;
    expect(entry.organizer).toEqual({ playerId: BROCK.professorPlayerId, name: null, connected: false, needsReconnect: false });
    expect(entry.type).toMatchObject({ status: 'unavailable' });
    expect(entry.actions).toEqual(['skip']);
  });

  it('takes the row’s series pick', async () => {
    upstream.state.series = [NOV];
    const { jan } = premierRows();
    service.updatePlanned(L, jan.plannedId!, { seriesId: 'custom' }, OWNER);
    const entry = (await service.upcoming(L, { from: '2026-10-12', to: '2027-02-01' })).tournaments.find((t) => t.plannedId === jan.plannedId)!;
    expect(entry.type).toEqual({ kind: 'custom' });
    expect(entry.actions).toContain('create');
  });

  it('offers no create for a start a DST change skips', async () => {
    const template = service.createTemplate(L, templateBody({ type: { kind: 'custom' }, startTime: '02:30' }), OWNER);
    now = new Date('2027-03-10T17:00:00Z');
    const planned = service.createPlanned(L, { templateId: template.id, localDate: '2027-03-14' });
    expect(planned).toMatchObject({ startsAt: null, timeProblem: 'nonexistent', actions: ['skip'] });
  });
});

describe('form options, read live as one professor', () => {
  const NOV = series('lc-nov', 'League Challenge November 2026', '2026-11-01', '2026-11-30');
  const OLD = series('lc-sep', 'League Challenge September 2026', '2026-09-01', '2026-09-30');

  it('offers Custom and the series whose window holds the date, with formats and venues', async () => {
    upstream.state.series = [NOV, OLD];
    const options = await service.options(L, { professor: OLIVE.professorPlayerId!, country: 'US', date: '2026-11-10' });
    expect(options).toEqual({
      types: [{ kind: 'custom' }, { kind: 'premier', seriesId: 'lc-nov', name: NOV.name, product: 'tcg', categories: ['tcg_std'], window: { from: '2026-11-01', to: '2026-11-30' } }],
      formats: [{ product: 'tcg', categories: ['tcg_std', 'tcg_exp'] }],
      venues: [{ id: expect.any(String), label: 'Card Shop', country: 'US', timeZone: 'America/Chicago' }],
    });
    expect(upstream.state.calls).toEqual(['listSeries@1', 'listFormats@1', 'listVenues@1']);
  });

  it('without a date, offers the series of the coming 12 months', async () => {
    upstream.state.series = [NOV, OLD];
    const options = await service.options(L, { professor: OLIVE.professorPlayerId!, country: 'US' });
    expect(options.types.map((t) => (t.kind === 'custom' ? 'custom' : t.seriesId))).toEqual(['custom', 'lc-nov']);
  });

  it('caches each read for 10 minutes, per professor', async () => {
    await service.options(L, { professor: OLIVE.professorPlayerId!, country: 'US' });
    await service.options(L, { professor: BROCK.professorPlayerId!, country: 'US' });
    now = new Date(NOON_WED.getTime() + 9 * MINUTE);
    await service.options(L, { professor: OLIVE.professorPlayerId!, country: 'US' });
    expect(upstream.state.calls).toHaveLength(6);
    now = new Date(NOON_WED.getTime() + 10 * MINUTE);
    await service.options(L, { professor: OLIVE.professorPlayerId!, country: 'US' });
    expect(upstream.state.calls).toHaveLength(9);
  });

  it('doesn’t cache a failure', async () => {
    upstream.state.failNext.set('listVenues', new PokemonUpstreamError('unavailable', 'down'));
    await expect(service.options(L, { professor: OLIVE.professorPlayerId!, country: 'US' })).rejects.toMatchObject({ code: 'unavailable' });
    await service.options(L, { professor: OLIVE.professorPlayerId!, country: 'US' });
    expect(upstream.state.calls.filter((c) => c.startsWith('listVenues'))).toHaveLength(2);
    expect(upstream.state.calls.filter((c) => c.startsWith('listSeries'))).toHaveLength(1);
  });

  it.each([
    ['an unknown professor', () => ({ professor: '1234567' }), 'connection_not_found'],
    ['one who needs a reconnect', () => (upstream.state.professors[1]!.status = 'needs_reconnect', { professor: BROCK.professorPlayerId! }), 'needs_reconnect'],
    ['no league chosen', () => ((upstream.state.connection = { ...upstream.state.connection, league: null }), { professor: OLIVE.professorPlayerId! }), 'league_not_selected'],
  ])('refuses %s with no call', async (_, arrange, code) => {
    const query = { country: 'US', ...arrange() };
    const err = await service.options(L, query).catch((e: unknown) => e);
    expect((err as TournamentsError).code).toBe(code);
    expect(upstream.state.calls).toEqual([]);
  });

  it('asks for series in the league’s activity group', async () => {
    upstream.state.series = [NOV];
    expect(GROUP).toBe(upstream.state.connection.league!.id);
    const options = await service.options(L, { professor: OLIVE.professorPlayerId!, country: 'US', date: '2026-11-10' });
    expect(options.types).toHaveLength(2);
  });
});
