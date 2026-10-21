import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import { HELD_BY_OWNER, OWNER } from '../pokemon/test-connections';
import { type TournamentsService, createTournamentsService } from './service';
import { BROCK, OLIVE, stubPlayTools, templateBody, upstreamTournament } from './test-helpers';

// What the calendar feeds read from the tournaments module (ADR-0016 §2 and §5): the fields a calendar event is built
// from, the professors whose listings were read, the one details read that decides a drop-out, and the change callback.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
/** Wednesday 2026-10-14, noon in Chicago. */
const NOON_WED = new Date('2026-10-14T17:00:00Z');
const RANGE = { from: '2026-09-14', to: '2027-04-14' } as const;

let database: OpenDatabase;
let upstream: ReturnType<typeof stubPlayTools>;
let service: TournamentsService;
let changes: string[];
let onChanged: (leagueId: string) => void;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  upstream = stubPlayTools();
  upstream.state.professors.push({ ...BROCK });
  changes = [];
  onChanged = (leagueId) => void changes.push(leagueId);
  service = createTournamentsService({
    db: database.db,
    connections: upstream.connections,
    gateway: upstream.gateway,
    timeZone: TZ,
    now: () => NOON_WED,
    onTournamentsChanged: (leagueId) => onChanged(leagueId),
  });
});
afterEach(() => database.close());

const link = (plannedId: number, tournamentId: string) =>
  database.sqlite.prepare("update planned_tournament set state = 'created', tournament_id = ? where id = ?").run(tournamentId, plannedId);

function plannedOne(overrides: Parameters<typeof templateBody>[0] = {}, localDate = '2026-10-20') {
  const template = service.createTemplate(
    L,
    templateBody({
      type: { kind: 'custom' },
      name: "Ettin's {month} TCG Challenge",
      eventWebsite: 'https://example.test/t1',
      contactEmail: 'secret@example.test',
      contactPhone: '555-0100',
      details: 'Private notes',
      ...overrides,
    }),
    OWNER,
  );
  return service.createPlanned(L, { templateId: template.id, localDate }).plannedId!;
}

describe('calendarEvents, refresh', () => {
  it('reads each readable professor once, and gives each tournament the fields a calendar event needs', async () => {
    const planned = plannedOne();
    link(planned, 'g1');
    upstream.state.tournaments = [
      upstreamTournament('g1', '2026-10-20T23:00:00Z', { applicationState: 'approval-pending' }),
      upstreamTournament('g2', '2026-10-17T16:00:00Z', { organizer: BROCK.professorPlayerId!, name: null, applicationState: 'sanctioned' }),
    ];

    const read = await service.calendarEvents(L, RANGE, 'refresh');

    expect(upstream.state.calls.sort()).toEqual(['listTournaments@1', 'listTournaments@2']);
    expect(read).toMatchObject({ upstream: 'read', read: [OLIVE.professorPlayerId, BROCK.professorPlayerId], failed: [], unmatched: false });
    expect(read.tournaments).toEqual([
      {
        plannedId: null,
        tournamentId: 'g2',
        state: 'upstream',
        organizerPlayerId: BROCK.professorPlayerId,
        name: null,
        startsAt: '2026-10-17T16:00:00.000Z',
        product: 'tcg',
        applicationState: 'sanctioned',
        venueLabel: null,
        registration: null,
        eventWebsite: null,
        listedBy: BROCK.professorPlayerId,
      },
      {
        plannedId: planned,
        tournamentId: 'g1',
        state: 'created',
        organizerPlayerId: OLIVE.professorPlayerId,
        name: "Ettin's October TCG Challenge",
        startsAt: '2026-10-20T23:00:00.000Z',
        product: 'tcg',
        applicationState: 'approval-pending',
        venueLabel: 'Card Shop',
        registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admissionCents: null },
        eventWebsite: 'https://example.test/t1',
        listedBy: OLIVE.professorPlayerId,
      },
    ]);
    expect(JSON.stringify(read)).not.toMatch(/secret@example|555-0100|Private notes|26-10-g/);
  });

  it('names the professors whose read failed, and counts a connection with no player ID as unmatched', async () => {
    upstream.state.failNext.set('listTournaments@2', new PokemonUpstreamError('unavailable', 'play-tools is down'));
    upstream.state.professors.push({ id: 3, professorPlayerId: '9999993', professorName: 'Misty', status: 'needs_reconnect', ...HELD_BY_OWNER });

    const read = await service.calendarEvents(L, RANGE, 'refresh');
    expect(read.read).toEqual([OLIVE.professorPlayerId]);
    expect(read.failed).toEqual([
      { playerId: BROCK.professorPlayerId, code: 'unavailable' },
      { playerId: '9999993', code: 'needs_reconnect' },
    ]);
    expect(read.unmatched).toBe(false);

    upstream.state.professors.push({ id: 4, professorPlayerId: null, professorName: null, status: 'connected', ...HELD_BY_OWNER });
    expect((await service.calendarEvents(L, RANGE, 'refresh')).unmatched).toBe(true);
  });

  it('leaves a planned row its listing no longer holds without listedBy, and gives a row with a time problem no start', async () => {
    const created = plannedOne();
    link(created, 'gone');
    const dst = plannedOne({ startTime: '02:30', name: 'Night owl' }, '2027-03-14');

    const read = await service.calendarEvents(L, RANGE, 'refresh');

    expect(read.tournaments.find((t) => t.plannedId === created)).toMatchObject({ tournamentId: 'gone', listedBy: null, applicationState: null });
    expect(read.tournaments.find((t) => t.plannedId === dst)).toMatchObject({ startsAt: null, timeProblem: 'nonexistent' });
  });

  it('with no league chosen, gives planned rows and calls nobody', async () => {
    plannedOne();
    upstream.state.connection = { ...upstream.state.connection, league: null };

    const read = await service.calendarEvents(L, RANGE, 'refresh');
    expect(read).toMatchObject({ upstream: 'league_not_selected', read: [], failed: [] });
    expect(read.tournaments).toHaveLength(1);
    expect(upstream.state.calls).toEqual([]);
  });
});

describe('calendarEvents, local', () => {
  it('reads only the planned rows, with no call to play-tools', async () => {
    const planned = plannedOne();
    link(planned, 'g1');
    upstream.state.tournaments = [upstreamTournament('g2', '2026-10-17T16:00:00Z')];

    const read = await service.calendarEvents(L, RANGE, 'local');

    expect(upstream.state.calls).toEqual([]);
    expect(read).toMatchObject({ upstream: 'local', read: [], failed: [], unmatched: false });
    expect(read.tournaments).toEqual([expect.objectContaining({ plannedId: planned, tournamentId: 'g1', listedBy: null, applicationState: null })]);
  });

  it('leaves out rows outside the range', async () => {
    plannedOne({}, '2027-05-01');
    expect((await service.calendarEvents(L, RANGE, 'local')).tournaments).toEqual([]);
  });
});

describe('checkTournament', () => {
  it("reads the tournament as its organizer's connection and says it still exists, with its start", async () => {
    upstream.state.tournaments = [upstreamTournament('g2', '2027-06-01T16:00:00Z', { organizer: BROCK.professorPlayerId! })];

    expect(await service.checkTournament(L, BROCK.professorPlayerId!, 'g2')).toEqual({ kind: 'exists', startsAt: '2027-06-01T16:00:00.000Z' });
    expect(upstream.state.calls).toEqual(['getTournament@2']);
  });

  it.each([
    ['play-tools has no such tournament', {}],
    ['its sanctioning state is cancelled', { applicationState: 'cancelled' }],
    ['its status is cancelled', { status: 'cancelled' }],
    ['its status is deleted', { status: 'deleted', applicationState: 'sanctioned' }],
    ['its status is invalidated', { status: 'invalidated', applicationState: 'sanctioned' }],
  ])('says it is cancelled when %s', async (what, opts) => {
    if (what !== 'play-tools has no such tournament') upstream.state.tournaments = [upstreamTournament('g1', '2026-10-20T23:00:00Z', opts)];

    expect(await service.checkTournament(L, OLIVE.professorPlayerId!, 'g1')).toEqual({ kind: 'cancelled' });
  });

  it('says it is unreadable when the read is refused or fails, or no connection has that player ID', async () => {
    upstream.state.tournaments = [upstreamTournament('g1', '2026-10-20T23:00:00Z')];
    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('forbidden', 'not yours'));
    expect(await service.checkTournament(L, OLIVE.professorPlayerId!, 'g1')).toEqual({ kind: 'unreadable' });

    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('unavailable', 'down'));
    expect(await service.checkTournament(L, OLIVE.professorPlayerId!, 'g1')).toEqual({ kind: 'unreadable' });

    upstream.state.calls = [];
    expect(await service.checkTournament(L, '0000000', 'g1')).toEqual({ kind: 'unreadable' });
    expect(upstream.state.calls).toEqual([]);
  });
});

describe('onTournamentsChanged', () => {
  it('is called once after each write that changes planned rows or their templates, and never by a read', async () => {
    const template = service.createTemplate(L, templateBody({ type: { kind: 'custom' } }), OWNER);
    expect(changes).toEqual([]);

    const planned = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-20' }).plannedId!;
    service.updatePlanned(L, planned, { skipped: true }, OWNER);
    service.updateTemplate(L, template.id, { name: 'Renamed {month}' }, OWNER);
    expect(changes).toEqual([L, L, L]);

    await service.upcoming(L, {});
    await service.calendarEvents(L, RANGE, 'refresh');
    expect(changes).toEqual([L, L, L]);
  });

  it('is called for schedule and scaffold changes', () => {
    const template = service.createTemplate(L, templateBody({ type: { kind: 'custom' } }), OWNER);
    const scaffold = service.createScaffold(L, { name: 'Tuesday', slots: [{ templateId: template.id, dayOffset: 0, startTime: null }] });
    const rule = { kind: 'weekly', weekday: 2, every: 1 } as const;
    const schedule = service.createSchedule(L, { scaffoldId: scaffold.id, rule, startsOn: '2026-09-01', endsOn: null, horizonWeeks: 4 });
    expect(changes).toEqual([L]);

    service.updateSchedule(L, schedule.id, { horizonWeeks: 6 });
    service.updateScaffold(L, scaffold.id, { name: 'Tuesday night' });
    service.archiveSchedule(L, schedule.id);
    service.archiveScaffold(L, scaffold.id);
    expect(changes).toEqual([L, L, L, L, L]);
  });

  it("doesn't fail a write when the callback throws", () => {
    onChanged = () => {
      throw new Error('calendar is down');
    };
    const template = service.createTemplate(L, templateBody({ type: { kind: 'custom' } }), OWNER);

    expect(() => service.createPlanned(L, { templateId: template.id, localDate: '2026-10-20' })).not.toThrow();
  });

  it('is called by changed(), which the submission module calls when a tournament job begins or ends', () => {
    service.changed(L);
    expect(changes).toEqual([L]);
  });
});
