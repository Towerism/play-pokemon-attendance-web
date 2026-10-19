import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import { TournamentsError } from './errors';
import { type TournamentsService, createTournamentsService } from './service';
import { BROCK, GROUP, OLIVE, VENUE, series, stubPlayTools, templateBody, upstreamTournament } from './test-helpers';
import { OWNER, professorActor } from '../pokemon/test-connections';

// The tournaments module's side of creating in play-tools (#92, ADR-0010 decision 5): which planned rows a job may
// take, what each would be created as or adopt, and what the rows become. The job itself is the submission module's.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
/** Wednesday 2026-10-14, noon in Chicago: the window starts on the 12th; short notice runs to the 20th. */
const NOON_WED = new Date('2026-10-14T17:00:00Z');

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

type Row = { state: string; tournament_id: string | null; last_attempt_at: number | null; error_code: string | null; display_id: string | null; upstream_status: string | null };
const rowOf = (id: number) => database.sqlite.prepare('select * from planned_tournament where id = ?').get(id) as Row;
const setRow = (id: number, set: string) => database.sqlite.prepare(`update planned_tournament set ${set} where id = ?`).run(id);

/** A Custom Friday Cup, by Olive, at 18:00 in Chicago. */
function customTemplate(overrides: Parameters<typeof templateBody>[0] = {}, actor = OWNER) {
  return service.createTemplate(L, templateBody({ name: 'Friday Cup {month}', type: { kind: 'custom' }, ...overrides }), actor);
}
const plan = (templateId: number, localDate: string, startTime?: string) =>
  service.createPlanned(L, { templateId, localDate, ...(startTime && { startTime }) }).plannedId!;

const OPTS = { retryUnknown: false, acknowledgeShortNotice: false };

describe('which planned rows a create job may take', () => {
  it('takes planned and failed rows, in start order, with their labels, organizer and short notice', () => {
    const t = customTemplate();
    const late = plan(t.id, '2026-11-06');
    const soon = plan(t.id, '2026-10-16');
    const earlier = plan(t.id, '2026-11-06', '12:00');
    setRow(late, "state = 'failed', error_code = 'refused'");

    const { targets } = service.creation.prepare(L, [late, soon, earlier], { ...OPTS, acknowledgeShortNotice: true }, OWNER);

    expect(targets.map((x) => x.plannedId)).toEqual([soon, earlier, late]);
    expect(targets[0]).toEqual({
      plannedId: soon,
      label: 'Friday Cup October · 2026-10-16',
      localDate: '2026-10-16',
      shortNotice: true,
      organizer: { playerId: OLIVE.professorPlayerId, name: 'Olive Organizer' },
    });
    expect(targets[2]!.shortNotice).toBe(false);
  });

  it('refuses another league’s or a missing row as not_found', () => {
    expect(() => service.creation.prepare(L, [999], OPTS, OWNER)).toThrow(expect.objectContaining({ code: 'not_found', details: { plannedTournamentId: 999 } }));
  });

  it.each(['skipped', 'creating', 'created', 'cancelled'])('refuses a %s row as not_creatable', (state) => {
    const id = plan(customTemplate().id, '2026-11-06');
    setRow(id, `state = '${state}'`);
    expect(() => service.creation.prepare(L, [id], OPTS, OWNER)).toThrow(expect.objectContaining({ code: 'not_creatable', details: { plannedTournamentId: id, state } }));
  });

  it('refuses a row before the creatable window', () => {
    const id = plan(customTemplate().id, '2026-10-12');
    now = new Date('2026-10-15T17:00:00Z');
    expect(() => service.creation.prepare(L, [id], OPTS, OWNER)).toThrow(expect.objectContaining({ code: 'date_too_far_past', details: { plannedTournamentId: id } }));
  });

  it('refuses a row whose organizer isn’t connected, or needs a reconnect', () => {
    const t = customTemplate({ organizerPlayerId: BROCK.professorPlayerId! as never });
    const id = plan(t.id, '2026-11-06');
    upstream.state.professors[1]!.status = 'needs_reconnect';
    expect(() => service.creation.prepare(L, [id], OPTS, OWNER)).toThrow(
      expect.objectContaining({ code: 'needs_reconnect', details: { plannedTournamentId: id, professorPlayerId: BROCK.professorPlayerId } }),
    );
    upstream.state.professors.pop();
    expect(() => service.creation.prepare(L, [id], OPTS, OWNER)).toThrow(expect.objectContaining({ code: 'organizer_not_connected' }));
  });

  it('takes an unknown row only with retryUnknown', () => {
    const id = plan(customTemplate().id, '2026-11-06');
    setRow(id, "state = 'unknown', last_attempt_at = 1");
    expect(() => service.creation.prepare(L, [id], OPTS, OWNER)).toThrow(expect.objectContaining({ code: 'retry_not_confirmed', details: { plannedTournamentIds: [id] } }));
    expect(service.creation.prepare(L, [id], { ...OPTS, retryUnknown: true }, OWNER).targets).toHaveLength(1);
  });

  it('needs short notice acknowledged for a date from today to six days ahead, not for a back-dated one', () => {
    const t = customTemplate();
    const soon = plan(t.id, '2026-10-20');
    const yesterday = plan(t.id, '2026-10-13');
    expect(() => service.creation.prepare(L, [soon, yesterday], OPTS, OWNER)).toThrow(
      expect.objectContaining({ code: 'short_notice_not_acknowledged', details: { plannedTournamentIds: [soon] } }),
    );
    expect(service.creation.prepare(L, [yesterday], OPTS, OWNER).targets).toHaveLength(1);
  });

  it('needs the league chosen', () => {
    const id = plan(customTemplate().id, '2026-11-06');
    upstream.state.connection = { ...upstream.state.connection, league: null };
    expect(() => service.creation.prepare(L, [id], OPTS, OWNER)).toThrow(expect.objectContaining({ code: 'league_not_selected' }));
  });

  it('changes nothing when it refuses', () => {
    const t = customTemplate();
    const ok = plan(t.id, '2026-11-06');
    const bad = plan(t.id, '2026-11-13');
    setRow(bad, "state = 'skipped'");
    expect(() => service.creation.prepare(L, [ok, bad], OPTS, OWNER)).toThrow(TournamentsError);
    expect(rowOf(ok).state).toBe('planned');
  });
});

describe('holding and releasing rows', () => {
  it('holds rows as creating, so a replan keeps them', () => {
    const id = plan(customTemplate().id, '2026-11-06');
    service.creation.hold(L, [id]);
    expect(rowOf(id).state).toBe('creating');
    expect(() => service.updatePlanned(L, id, { skipped: true }, OWNER)).toThrow(expect.objectContaining({ code: 'not_editable' }));
  });

  it('releases a row never sent to planned, and one sent before to unknown', () => {
    const t = customTemplate();
    const fresh = plan(t.id, '2026-11-06');
    const tried = plan(t.id, '2026-11-13');
    setRow(tried, 'last_attempt_at = 1');
    service.creation.hold(L, [fresh, tried]);
    service.creation.release(L, fresh);
    service.creation.release(L, tried);
    expect([rowOf(fresh).state, rowOf(tried).state]).toEqual(['planned', 'unknown']);
  });

  it('records a send, a creation, its reconcile, an unknown outcome and a failure', () => {
    const t = customTemplate();
    const [a, b, c] = [plan(t.id, '2026-11-06'), plan(t.id, '2026-11-13'), plan(t.id, '2026-11-20')];
    service.creation.hold(L, [a, b, c]);
    service.creation.recordSent(L, a, new Date('2026-10-14T17:05:00Z'));
    service.creation.recordCreated(L, a, 'g-1');
    service.creation.recordReconciled(L, a, { displayId: '26-11-000001', status: 'approval-pending' });
    service.creation.recordUnknown(L, b);
    service.creation.recordFailed(L, c, 'venue_not_found');
    expect(rowOf(a)).toMatchObject({ state: 'created', tournament_id: 'g-1', display_id: '26-11-000001', upstream_status: 'approval-pending', last_attempt_at: 1_791_997_500 });
    expect(rowOf(b).state).toBe('unknown');
    expect(rowOf(c)).toMatchObject({ state: 'failed', error_code: 'venue_not_found' });
  });

  it('lists which rows of a finished job are still planned or failed, for a retry', () => {
    const t = customTemplate();
    const [a, b, c] = [plan(t.id, '2026-11-06'), plan(t.id, '2026-11-13'), plan(t.id, '2026-11-20')];
    setRow(b, "state = 'failed'");
    setRow(c, "state = 'unknown'");
    expect(service.creation.retryable(L, [a, b, c])).toEqual([a, b]);
  });
});

describe('what each row is created as (planItem)', () => {
  it('builds a Custom tournament from the resolved settings, as the organizer', async () => {
    const t = customTemplate({ details: 'Bring a deck', eventWebsite: 'https://example.com/cup' });
    const id = plan(t.id, '2026-11-06');
    service.creation.hold(L, [id]);

    const item = await service.creation.planItem(L, id);

    expect(item).toEqual({
      kind: 'send',
      connectionId: OLIVE.id,
      localDate: '2026-11-06',
      match: { startsAt: new Date('2026-11-07T00:00:00Z'), product: 'tcg', name: 'Friday Cup November', groupId: GROUP, category: 'tcg_std' },
      tournament: {
        name: 'Friday Cup November',
        groupId: GROUP,
        product: 'tcg',
        category: 'tcg_std',
        seriesId: null,
        venueId: VENUE.id,
        startsAt: new Date('2026-11-07T00:00:00Z'),
        contact: { email: 'league@example.com', phone: null },
        registration: { startsAt: new Date('2026-11-06T23:00:00Z'), endsAt: new Date('2026-11-07T00:15:00Z') },
        onSiteAdmission: null,
        details: 'Bring a deck',
        eventWebsite: 'https://example.com/cup',
      },
    });
    // One listing at the start instant, then the venue check; nothing written.
    expect(upstream.state.calls).toEqual(['listTournaments@1', 'listVenues@1']);
  });

  it('sends a third-party registration as its URL, with no window', async () => {
    const t = customTemplate({ registration: { kind: 'third_party', url: 'https://tickets.example.com' } });
    const id = plan(t.id, '2026-11-06');
    const item = await service.creation.planItem(L, id);
    expect(item).toMatchObject({ kind: 'send', tournament: { thirdPartyRegistrationUrl: 'https://tickets.example.com', registration: null } });
  });

  it('adopts a live tournament of the organizer with the same start, product, name and format', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    upstream.state.tournaments = [upstreamTournament('g-hand', '2026-11-07T00:00:00Z', { name: 'FRIDAY cup november' })];
    expect(await service.creation.planItem(L, id)).toEqual({ kind: 'adopt', connectionId: OLIVE.id, tournamentId: 'g-hand' });
    expect(upstream.state.calls).toEqual(['listTournaments@1', 'getTournament@1']);
  });

  it('doesn’t adopt one of another format, or one another row holds', async () => {
    const t = customTemplate();
    const id = plan(t.id, '2026-11-06');
    const other = plan(t.id, '2026-11-13');
    upstream.state.tournaments = [
      upstreamTournament('g-exp', '2026-11-07T00:00:00Z', { name: 'Friday Cup November', category: 'tcg_exp' }),
      upstreamTournament('g-held', '2026-11-07T00:00:00Z', { name: 'Friday Cup November' }),
    ];
    setRow(other, "state = 'created', tournament_id = 'g-held'");
    expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'send' });
  });

  it('resolves a premier row’s series for its date, and checks the format is one of its formats', async () => {
    const t = service.createTemplate(L, templateBody(), OWNER);
    const id = plan(t.id, '2026-11-06');
    upstream.state.series = [series('lc-nov', 'League Challenge November', '2026-11-01', '2026-11-30')];
    expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'send', tournament: { seriesId: 'lc-nov' } });

    upstream.state.series = [{ ...series('lc-nov', 'League Challenge November', '2026-11-01', '2026-11-30'), categories: ['tcg_exp'] }];
    service = createTournamentsService({ db: database.db, connections: upstream.connections, gateway: upstream.gateway, timeZone: TZ, now: () => now });
    expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'fail', code: 'format_not_in_series' });
  });

  it.each([
    ['series_not_found', []],
    ['series_ambiguous', [series('a', 'League Challenge A', '2026-11-01', '2026-11-30'), series('b', 'League Challenge B', '2026-11-01', '2026-11-30')]],
  ] as const)('fails a premier row whose series is %s, before any write', async (code, list) => {
    const id = plan(service.createTemplate(L, templateBody(), OWNER).id, '2026-11-06');
    upstream.state.series = [...list];
    expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'fail', code });
  });

  it('fails series_unavailable when play-tools’ series can’t be read', async () => {
    const id = plan(service.createTemplate(L, templateBody(), OWNER).id, '2026-11-06');
    upstream.state.failNext.set('listSeries', new PokemonUpstreamError('unavailable', 'Pokémon is down.'));
    expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'fail', code: 'series_unavailable' });
  });

  it('fails venue_not_found when the venue left the organizer’s address book', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    upstream.state.venues = [];
    expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'fail', code: 'venue_not_found' });
  });

  describe('a one-off with details changed from its template (#162)', () => {
    const HALL = { id: '00000000-0000-4000-8000-000000000052', label: 'Town Hall', timeZone: 'America/Chicago', country: 'US' };
    const planWith = (templateId: number, overrides: object, seriesId?: string) =>
      service.createPlanned(L, { templateId, localDate: '2026-11-06', overrides, ...(seriesId && { seriesId }) }).plannedId!;

    it('is created with its own details and type, and the template’s organizer and game', async () => {
      upstream.state.venues.push({ id: HALL.id, name: HALL.label, formattedAddress: '2 Main St', country: 'US', timeZone: 'America/Chicago' });
      upstream.state.series = [series('lc-nov', 'League Challenge November', '2026-11-01', '2026-11-30')];
      const t = service.createTemplate(L, templateBody({ details: 'Template details' }), OWNER);
      const id = planWith(t.id, { name: 'Halloween Cup', category: 'tcg_exp', venue: HALL, details: 'Costumes welcome' }, 'custom');

      const item = await service.creation.planItem(L, id);

      expect(item).toMatchObject({
        kind: 'send',
        connectionId: OLIVE.id,
        match: { name: 'Halloween Cup', category: 'tcg_exp', product: 'tcg' },
        tournament: { name: 'Halloween Cup', product: 'tcg', category: 'tcg_exp', seriesId: null, venueId: HALL.id, details: 'Costumes welcome' },
      });
      // Custom needs no series read.
      expect(upstream.state.calls).not.toContain('listSeries@1');
    });

    it('without the type change, the same template is created in its series', async () => {
      upstream.state.series = [series('lc-nov', 'League Challenge November', '2026-11-01', '2026-11-30')];
      const id = planWith(service.createTemplate(L, templateBody(), OWNER).id, { name: 'Halloween Cup' });
      expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'send', tournament: { name: 'Halloween Cup', seriesId: 'lc-nov' } });
    });

    it('fails a pick of another game’s series as series_not_found', async () => {
      upstream.state.series = [series('go-nov', 'League Challenge November', '2026-11-01', '2026-11-30', 'pgo')];
      const id = planWith(service.createTemplate(L, templateBody(), OWNER).id, {}, 'go-nov');
      expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'fail', code: 'series_not_found' });
    });

    it('fails contact_required, sending nothing, when a later template edit left it no contact', async () => {
      const t = customTemplate({ contactPhone: '555-0100' });
      const id = planWith(t.id, { contactEmail: null });
      service.updateTemplate(L, t.id, { contactPhone: null }, OWNER);
      expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'fail', code: 'contact_required', message: 'Give this tournament a contact email or phone.' });
    });

    it('fails venue_not_found when the address book now gives the venue another time zone or country', async () => {
      const id = plan(customTemplate().id, '2026-11-06');
      upstream.state.venues = [{ ...upstream.state.venues[0]!, timeZone: 'America/New_York' }];
      // The template's venue: fixed on the template, where every later date takes it from.
      expect(await service.creation.planItem(L, id)).toMatchObject({
        kind: 'fail',
        code: 'venue_not_found',
        message: "Card Shop has changed in the organizer's address book. Pick the venue again on the template.",
      });
      upstream.state.venues = [{ ...upstream.state.venues[0]!, timeZone: 'America/Chicago', country: 'CA' }];
      expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'fail', code: 'venue_not_found' });
    });

    it('says to pick the venue again on the tournament when the venue is its own', async () => {
      upstream.state.venues.push({ id: HALL.id, name: HALL.label, formattedAddress: '2 Main St', country: 'US', timeZone: 'America/Denver' });
      const id = planWith(customTemplate().id, { venue: HALL });
      expect(await service.creation.planItem(L, id)).toMatchObject({
        kind: 'fail',
        code: 'venue_not_found',
        message: "Town Hall has changed in the organizer's address book. Pick the venue again on this tournament.",
      });
    });

    it('takes a venue whose time zone and country the address book leaves out, as the dialog stores it', async () => {
      const id = plan(customTemplate().id, '2026-11-06');
      upstream.state.venues = [{ ...upstream.state.venues[0]!, timeZone: null, country: null }];
      expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'send' });
    });

    it('refuses a zone or country the address book leaves out when it isn’t what the dialog would store', async () => {
      upstream.state.venues.push({ id: HALL.id, name: HALL.label, formattedAddress: '2 Main St', country: null, timeZone: null });
      const zoned = planWith(customTemplate().id, { venue: { ...HALL, timeZone: 'Pacific/Kiritimati' } });
      expect(await service.creation.planItem(L, zoned)).toMatchObject({ kind: 'fail', code: 'venue_not_found' });
      const abroad = planWith(customTemplate({ name: 'Other {month}' }).id, { venue: { ...HALL, country: 'CA' } });
      expect(await service.creation.planItem(L, abroad)).toMatchObject({ kind: 'fail', code: 'venue_not_found' });
    });
  });

  it('fails start_time_invalid for a start the DST change skips or repeats', async () => {
    const t = customTemplate({ startTime: '01:30' });
    const id = plan(t.id, '2026-11-01');
    expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'fail', code: 'start_time_invalid' });
    expect(upstream.state.calls).toEqual([]);
  });

  it('fails listing_unavailable, sending nothing, when the listing or a candidate’s details can’t be read', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    upstream.state.failNext.set('listTournaments', new PokemonUpstreamError('unavailable', 'Pokémon is down.', { status: 503 }));
    expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'fail', code: 'listing_unavailable', error: expect.any(PokemonUpstreamError) });

    upstream.state.tournaments = [upstreamTournament('g', '2026-11-07T00:00:00Z', { name: 'Friday Cup November' })];
    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('unavailable', 'Pokémon is down.'));
    expect(await service.creation.planItem(L, id)).toMatchObject({ kind: 'fail', code: 'listing_unavailable' });
  });

  it('throws when the organizer can’t act: the job stops', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    upstream.state.failNext.set('listTournaments', new PokemonUpstreamError('forbidden', 'Refused.', { status: 403 }));
    await expect(service.creation.planItem(L, id)).rejects.toMatchObject({ code: 'forbidden' });
    upstream.state.professors[0]!.status = 'needs_reconnect';
    await expect(service.creation.planItem(L, id)).rejects.toMatchObject({ code: 'needs_reconnect' });
    upstream.state.professors.shift();
    await expect(service.creation.planItem(L, id)).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('finds a create that landed late (settling), or nothing', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    const item = await service.creation.planItem(L, id);
    if (item.kind !== 'send') throw new Error('expected a send');
    expect(await service.creation.findLanded(L, item.connectionId, item.match)).toBeNull();
    upstream.state.tournaments = [upstreamTournament('g-late', '2026-11-07T00:00:00Z', { name: 'Friday Cup November' })];
    expect(await service.creation.findLanded(L, item.connectionId, item.match)).toBe('g-late');
    upstream.state.failNext.set('listTournaments', new PokemonUpstreamError('unavailable', 'Down.'));
    await expect(service.creation.findLanded(L, item.connectionId, item.match)).rejects.toBeInstanceOf(PokemonUpstreamError);
  });

  it('checks the creatable window with its clock', () => {
    expect(service.creation.windowProblem('2026-10-12')).toBeNull();
    now = new Date('2026-10-15T05:01:00Z'); // 00:01 on the 15th in Chicago
    expect(service.creation.windowProblem('2026-10-12')).toBe('date_too_far_past');
  });
});

describe('linking an unknown row on read (Upcoming)', () => {
  it('links it to its tournament once play-tools lists it, with no write, and offers retry_create until then', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    setRow(id, "state = 'unknown', last_attempt_at = 1791997500");

    const before = (await service.upcoming(L, {})).tournaments.find((e) => e.plannedId === id)!;
    expect(before).toMatchObject({ state: 'unknown', lastAttemptAt: '2026-10-14T17:05:00.000Z', actions: ['skip', 'retry_create'] });

    upstream.state.tournaments = [upstreamTournament('g-late', '2026-11-07T00:00:00Z', { name: 'Friday Cup November', applicationState: 'approval-pending' })];
    // Upcoming's listing is cached for 5 minutes (#98): Refresh sees the late create at once.
    const after = (await service.upcoming(L, { refresh: true })).tournaments.filter((e) => e.localDate === '2026-11-06');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ plannedId: id, state: 'created', tournamentId: 'g-late', displayId: '26-10-g-late', actions: [] });
    expect(rowOf(id)).toMatchObject({ state: 'created', tournament_id: 'g-late' });
  });

  it('leaves it unknown when the candidate’s details can’t be read, or its format differs', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    setRow(id, "state = 'unknown'");
    upstream.state.tournaments = [upstreamTournament('g', '2026-11-07T00:00:00Z', { name: 'Friday Cup November', category: 'tcg_exp' })];
    await service.upcoming(L, {});
    expect(rowOf(id).state).toBe('unknown');
    upstream.state.tournaments[0]!.category = 'tcg_std';
    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('unavailable', 'Down.'));
    await service.upcoming(L, {});
    expect(rowOf(id).state).toBe('unknown');
  });
});

describe('linking a row skipped while its create may have landed (#125)', () => {
  const landed = () => upstreamTournament('g-late', '2026-11-07T00:00:00Z', { name: 'Friday Cup November' });
  /** An unknown row for Friday 2026-11-06, skipped. */
  function heldRow(templateId = customTemplate().id) {
    const id = plan(templateId, '2026-11-06');
    setRow(id, "state = 'unknown', last_attempt_at = 1791997500");
    service.updatePlanned(L, id, { skipped: true }, OWNER);
    return id;
  }
  /** Holds the getTournament calls numbered in `held` until the returned function opens the gate. */
  function gateDetails(held: number[]) {
    let n = 0;
    let release!: () => void;
    const shut = new Promise<void>((r) => (release = r));
    upstream.state.gate = async (name) => {
      if (name !== 'getTournament') return;
      if (held.includes(++n)) await shut;
    };
    return () => release();
  }
  const writes = () => upstream.state.calls.filter((c) => !/^(listTournaments|getTournament|listSeries)@/.test(c));
  const flagOf = (id: number) => (database.sqlite.prepare('select skipped_while_unknown as f from planned_tournament where id = ?').get(id) as { f: number }).f;

  it('links it once the tournament shows up, keeping it skipped here, listed once, with nothing written upstream', async () => {
    const id = heldRow();
    expect((await service.upcoming(L, {})).tournaments.find((e) => e.plannedId === id)).toMatchObject({ state: 'skipped', skippedWhileUnknown: true, tournamentId: null });

    upstream.state.tournaments = [landed()];
    const after = (await service.upcoming(L, { refresh: true })).tournaments.filter((e) => e.localDate === '2026-11-06');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ plannedId: id, state: 'skipped', skippedWhileUnknown: true, tournamentId: 'g-late', displayId: '26-10-g-late', actions: ['unskip'] });
    expect(rowOf(id)).toMatchObject({ state: 'skipped', tournament_id: 'g-late', error_code: null });
    expect(writes()).toEqual([]);
  });

  it('links it through the required-events read too', async () => {
    const id = heldRow();
    upstream.state.tournaments = [landed()];
    await service.requiredEvents.read(L, { refresh: true });
    expect(rowOf(id)).toMatchObject({ state: 'skipped', tournament_id: 'g-late' });
  });

  it.each([
    ['another name', { name: 'Saturday Cup' }],
    ['another start', { startsAt: new Date('2026-11-07T01:00:00Z') }],
    ['another format', { category: 'tcg_exp' }],
  ])('leaves it unlinked for a tournament with %s', async (_, differs) => {
    const id = heldRow();
    upstream.state.tournaments = [{ ...landed(), ...differs }];
    await service.upcoming(L, {});
    expect(rowOf(id)).toMatchObject({ state: 'skipped', tournament_id: null });
  });

  it('leaves it unlinked when the tournament is already another row’s', async () => {
    const t = customTemplate();
    const other = plan(t.id, '2026-11-13');
    setRow(other, "tournament_id = 'g-late', state = 'created'");
    const id = heldRow(t.id);
    upstream.state.tournaments = [landed()];
    await service.upcoming(L, {});
    expect(rowOf(id).tournament_id).toBeNull();
  });

  it('gives a row unskipped during the details read what an unknown row gets: created', async () => {
    const id = heldRow();
    upstream.state.tournaments = [landed()];
    const open = gateDetails([1]);
    const reading = service.upcoming(L, {});
    await vi.waitUntil(() => upstream.state.calls.includes('getTournament@1'));
    service.updatePlanned(L, id, { skipped: false }, OWNER);
    open();
    await reading;
    expect(rowOf(id)).toMatchObject({ state: 'created', tournament_id: 'g-late' });
  });

  it('keeps a row skipped during the details read skipped, and links it', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    setRow(id, "state = 'unknown', last_attempt_at = 1791997500");
    upstream.state.tournaments = [landed()];
    const open = gateDetails([1]);
    const reading = service.upcoming(L, {});
    await vi.waitUntil(() => upstream.state.calls.includes('getTournament@1'));
    service.updatePlanned(L, id, { skipped: true }, OWNER);
    open();
    await reading;
    expect(rowOf(id)).toMatchObject({ state: 'skipped', tournament_id: 'g-late' });
    expect(flagOf(id)).toBe(1);
  });

  it('writes no link for a row a create job took during the details read', async () => {
    const id = plan(customTemplate().id, '2026-11-06');
    setRow(id, "state = 'unknown', last_attempt_at = 1791997500");
    upstream.state.tournaments = [landed()];
    const open = gateDetails([1]);
    const reading = service.upcoming(L, {});
    await vi.waitUntil(() => upstream.state.calls.includes('getTournament@1'));
    service.creation.hold(L, [id]);
    open();
    await reading;
    expect(rowOf(id)).toMatchObject({ state: 'creating', tournament_id: null });
  });

  it('links one tournament to one row when two reads race for it, and both reads answer', async () => {
    const first = plan(customTemplate().id, '2026-11-06');
    setRow(first, "state = 'unknown', last_attempt_at = 1791997500");
    const second = heldRow(customTemplate({ name: 'Friday Cup {month}', startTime: '18:00' }).id);
    upstream.state.tournaments = [landed()];
    // Read A: the first row's details read fails and the second row's is held, while read B links the first row.
    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('unavailable', 'Down.'));
    const open = gateDetails([2]);
    const a = service.upcoming(L, {});
    await vi.waitUntil(() => upstream.state.calls.filter((c) => c === 'getTournament@1').length === 2);
    const b = await service.upcoming(L, {});
    expect(rowOf(first).tournament_id).toBe('g-late');
    open();
    await expect(a).resolves.toBeDefined();
    expect(b.tournaments.filter((e) => e.tournamentId === 'g-late')).toHaveLength(1);
    expect(rowOf(second).tournament_id).toBeNull();
  });
});

describe('create through a date', () => {
  /** Monthly on the third Tuesday from October, a 4-week horizon. */
  function monthly() {
    const t = customTemplate({ name: 'Third Tuesday {month}' });
    const scaffold = service.createScaffold(L, { name: 'Third Tuesday', slots: [{ templateId: t.id, dayOffset: 0, startTime: null }] });
    return service.createSchedule(L, { scaffoldId: scaffold.id, rule: { kind: 'monthly', nth: 3, weekday: 2 }, startsOn: '2026-10-01', endsOn: null, horizonWeeks: 4 });
  }

  it('lists every row through the date, past the horizon, with what it leaves out, and keeps them on later reads', async () => {
    const schedule = monthly();
    const first = await service.createThrough(L, schedule.id, '2027-02-28');
    expect(first.tournaments.map((e) => e.localDate)).toEqual(['2026-10-20', '2026-11-17', '2026-12-15', '2027-01-19', '2027-02-16']);
    expect(first.tournaments[0]).toMatchObject({ shortNotice: true, name: 'Third Tuesday October' });
    expect(first).toMatchObject({ scheduleId: schedule.id, scaffoldName: 'Third Tuesday', from: '2026-10-12', through: '2027-02-28', count: 5, tooMany: false, suggestedThrough: null });

    setRow(first.tournaments[1]!.plannedId!, "state = 'skipped'");
    setRow(first.tournaments[2]!.plannedId!, "state = 'created', tournament_id = 'g-dec'");
    await service.upcoming(L, {});
    const second = await service.createThrough(L, schedule.id, '2027-02-28');
    expect(second.tournaments.map((e) => e.localDate)).toEqual(['2026-10-20', '2027-01-19', '2027-02-16']);
    expect(second.leftOut.map((l) => [l.entry.localDate, l.reason])).toEqual([
      ['2026-11-17', 'skipped'],
      ['2026-12-15', 'in_play_tools'],
    ]);
  });

  it('refuses a paused schedule, a date before the window, or more than 12 months ahead', async () => {
    const schedule = monthly();
    await expect(service.createThrough(L, schedule.id, '2026-10-11')).rejects.toMatchObject({ code: 'date_too_far_past' });
    await expect(service.createThrough(L, schedule.id, '2027-10-15')).rejects.toMatchObject({ code: 'date_too_far_ahead' });
    await expect(service.createThrough(L, 999, '2026-12-31')).rejects.toMatchObject({ code: 'not_found' });
    service.updateSchedule(L, schedule.id, { paused: true });
    await expect(service.createThrough(L, schedule.id, '2026-12-31')).rejects.toMatchObject({ code: 'schedule_inactive' });
  });

  it('records how far a schedule is in play-tools, never moving it back', () => {
    const schedule = monthly();
    service.creation.recordCreatedThrough(L, schedule.id, '2026-12-31');
    service.creation.recordCreatedThrough(L, schedule.id, '2026-11-30');
    expect(service.listSchedules(L)[0]!.createdThrough).toBe('2026-12-31');
  });
});

describe('a create across organizers (ADR-0015 §4)', () => {
  const MISTY = professorActor(2, 'misty');

  beforeEach(() => {
    upstream.state.professors = upstream.state.professors.map((p) => (p.id === BROCK.id ? { ...p, userId: MISTY.userId } : p));
  });

  it("takes the rows whose organizer the caller holds and names the others, refused", () => {
    const olives = plan(customTemplate().id, '2026-11-06');
    const brocks = plan(customTemplate({ organizerPlayerId: BROCK.professorPlayerId as never }, MISTY).id, '2026-11-06', '12:00');

    const { targets, refused } = service.creation.prepare(L, [olives, brocks], OPTS, OWNER);

    expect(targets.map((x) => x.plannedId)).toEqual([olives]);
    expect(refused).toEqual([{ plannedTournamentId: brocks, code: 'not_your_connection', professorPlayerId: BROCK.professorPlayerId }]);
  });

  it('refuses a create with no row the caller may act on', () => {
    const olives = plan(customTemplate().id, '2026-11-06');
    expect(() => service.creation.prepare(L, [olives], OPTS, MISTY)).toThrow(expect.objectContaining({ code: 'not_your_connection' }));
  });
});

