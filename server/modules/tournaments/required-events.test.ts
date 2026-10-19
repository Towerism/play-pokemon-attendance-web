import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import type { ActingConnection } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import { type TournamentsService, createTournamentsService } from './service';
import { BROCK, OLIVE, type StubTournament, series, stubPlayTools, templateBody, upstreamTournament } from './test-helpers';
import { HELD_BY_OWNER, OWNER } from '../pokemon/test-helpers';

// Gathering required-events coverage (ADR-0010 decision 12, #95): each connected professor's listing (cached 5
// minutes), each tournament's series from its details (cached by guid), play-tools' series windows, planned rows.
// The clock is fixed and moved by hand; held calls use the stub's gate, never sleeps.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
/** Wednesday 2026-10-14, noon in Chicago. */
const NOON_WED = new Date('2026-10-14T17:00:00Z');
const MINUTE = 60_000;
const MISTY: ActingConnection = { id: 3, professorPlayerId: '9999993', professorName: 'Misty', status: 'needs_reconnect', ...HELD_BY_OWNER };

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

/** Only the TCG League Challenge stays on, so each case reads one row of periods. */
function onlyTcgChallenge() {
  for (const r of service.requirements.list(L)) {
    if (!(r.product === 'tcg' && r.seriesMatch === 'League Challenge')) service.requirements.update(L, r.id, { active: false });
  }
}

/** A sanctioned TCG League Challenge, in November by default, organized by Olive. */
function challenge(id: string, startsAt = '2026-11-14T18:00:00Z', opts: Partial<StubTournament> = {}): StubTournament {
  return upstreamTournament(id, startsAt, { applicationState: 'sanctioned', details: { series: { id: 'lc-nov', name: 'League Challenge November' } }, ...opts });
}

/** play-tools' series can't be read by anyone, for the rest of the test. */
function seriesDown() {
  const base = upstream.gateway;
  upstream.gateway = (as) => ({ ...base(as), listSeries: () => Promise.reject(new PokemonUpstreamError('unavailable', 'down')) });
  service = createTournamentsService({ db: database.db, connections: upstream.connections, gateway: upstream.gateway, timeZone: TZ, now: () => now });
}

const calls = (name: string) => upstream.state.calls.filter((c) => c.startsWith(`${name}@`));
const reset = () => (upstream.state.calls = []);
const read = (refresh = false) => service.requiredEvents.read(L, { refresh });
const nov = async (refresh = false) => (await read(refresh)).requirements[0]!.periods.find((p) => p.periodStart === '2026-11-01')!;

/** A deferred the test resolves by hand. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

describe('reading the league', () => {
  it('lists once per connected professor over every period, skipping one who must reconnect', async () => {
    onlyTcgChallenge();
    service.requirements.update(L, service.requirements.list(L)[0]!.id, { active: true }); // the TCG League Cup: quarters
    upstream.state.professors.push({ ...MISTY });
    const ranges: { as: number; from: string; to: string }[] = [];
    const listing = upstream.gateway;
    upstream.gateway = (as) => ({ ...listing(as), listTournaments: (range) => (ranges.push({ as, from: range!.from.toISOString(), to: range!.to.toISOString() }), listing(as).listTournaments(range)) });
    service = createTournamentsService({ db: database.db, connections: upstream.connections, gateway: upstream.gateway, timeZone: TZ, now: () => now });

    const result = await read();

    // Q3 2026 start to Q1 2027 end, as Chicago midnights.
    expect(ranges).toEqual([
      { as: OLIVE.id, from: '2026-07-01T05:00:00.000Z', to: '2027-04-01T05:00:00.000Z' },
      { as: BROCK.id, from: '2026-07-01T05:00:00.000Z', to: '2027-04-01T05:00:00.000Z' },
    ]);
    expect(result.unread).toEqual([{ professor: { playerId: MISTY.professorPlayerId, name: 'Misty' }, code: 'needs_reconnect', message: expect.any(String) }]);
    expect(result).toMatchObject({ timeZone: TZ, today: '2026-10-14', country: 'US', upstream: 'read' });
  });

  it('counts a tournament once, and takes its series from its details, as the professor who listed it', async () => {
    onlyTcgChallenge();
    upstream.state.tournaments = [challenge('g1', '2026-11-14T18:00:00Z', { organizer: BROCK.professorPlayerId! })];

    const p = await nov();

    expect(p).toMatchObject({ status: 'sanctioned', tournaments: [{ tournamentId: 'g1', class: 'sanctioned', organizer: { playerId: BROCK.professorPlayerId } }] });
    expect(calls('getTournament')).toEqual([`getTournament@${BROCK.id}`]);
  });

  it.each([
    ['unavailable', 'upstream_unavailable'],
    ['rate_limited', 'upstream_unavailable'],
    ['forbidden', 'refused'],
    ['refused', 'refused'],
    ['not_found', 'refused'],
    ['unexpected_shape', 'refused'],
  ] as const)('names a professor whose listing fails %s as %s, and never shows missing', async (code, as) => {
    onlyTcgChallenge();
    upstream.state.failNext.set(`listTournaments@${BROCK.id}`, new PokemonUpstreamError(code, 'nope'));

    const result = await read();

    expect(result.unread).toEqual([{ professor: { playerId: BROCK.professorPlayerId, name: 'Brock' }, code: as, message: 'nope' }]);
    expect(result.requirements[0]!.periods.every((p) => p.status === 'unknown')).toBe(true);
  });

  it('rejects on an error that is not play-tools’', async () => {
    onlyTcgChallenge();
    const listing = upstream.gateway;
    upstream.gateway = (as) => ({ ...listing(as), listTournaments: () => Promise.reject(new TypeError('bug')) });
    service = createTournamentsService({ db: database.db, connections: upstream.connections, gateway: upstream.gateway, timeZone: TZ, now: () => now });
    await expect(read()).rejects.toThrow('bug');
  });

  it('is unknown, with no calls, when nobody is connected or no league is selected', async () => {
    onlyTcgChallenge();
    upstream.state.professors = [];
    expect(await read()).toMatchObject({ upstream: 'not_connected' });
    upstream.state.professors = [{ ...OLIVE }];
    upstream.state.connection = { ...upstream.state.connection, league: null };
    const result = await read();
    expect(result.upstream).toBe('league_not_selected');
    expect(result.requirements[0]!.periods.every((p) => p.status === 'unknown' && p.bestKnown === 'missing')).toBe(true);
    expect(upstream.state.calls).toEqual([]);
  });

  it('makes no calls at all with no requirement switched on', async () => {
    for (const r of service.requirements.list(L)) service.requirements.update(L, r.id, { active: false });
    expect((await read()).requirements).toEqual([]);
    expect(upstream.state.calls).toEqual([]);
  });
});

describe('the listing cache', () => {
  beforeEach(() => {
    onlyTcgChallenge();
    upstream.state.tournaments = [challenge('g1')];
  });

  it('reuses each listing for 5 minutes, then reads again', async () => {
    await read();
    reset();
    now = new Date(NOON_WED.getTime() + 5 * MINUTE - 1000);
    await read();
    expect(calls('listTournaments')).toEqual([]);
    now = new Date(NOON_WED.getTime() + 5 * MINUTE);
    await read();
    expect(calls('listTournaments')).toEqual([`listTournaments@${OLIVE.id}`, `listTournaments@${BROCK.id}`]);
  });

  it('reads again on refresh, after a failure, and after a tournament job ends', async () => {
    upstream.state.failNext.set(`listTournaments@${BROCK.id}`, new PokemonUpstreamError('unavailable', 'down'));
    await read();
    reset();
    await read();
    expect(calls('listTournaments')).toEqual([`listTournaments@${BROCK.id}`]);
    reset();
    await read(true);
    expect(calls('listTournaments')).toHaveLength(2);
    reset();
    service.requiredEvents.listingsChanged();
    await read();
    expect(calls('listTournaments')).toHaveLength(2);
  });

  it('makes no play-tools call at all on a warm read', async () => {
    upstream.state.series = [series('lc', 'League Challenge', '2026-11-01', '2026-11-30')];
    await read();
    reset();
    await read();
    expect(upstream.state.calls).toEqual([]);
  });

  it('shares one listing between two reads at once', async () => {
    const held = gate();
    upstream.state.gate = (name) => (name === 'listTournaments' ? held.promise : Promise.resolve());
    const first = read();
    const second = read();
    held.open();
    const [a, b] = await Promise.all([first, second]);
    expect(calls('listTournaments')).toEqual([`listTournaments@${OLIVE.id}`, `listTournaments@${BROCK.id}`]);
    expect(calls('getTournament')).toHaveLength(1);
    expect(b).toEqual(a);
  });

  it('never caches a listing that was in flight when a job ended', async () => {
    const held = gate();
    upstream.state.gate = (name) => (name === 'listTournaments' ? held.promise : Promise.resolve());
    const first = read();
    await Promise.resolve();
    service.requiredEvents.listingsChanged();
    held.open();
    expect((await first).requirements[0]!.periods.find((p) => p.periodStart === '2026-11-01')!.status).toBe('sanctioned');
    upstream.state.gate = undefined;
    reset();
    await read();
    // Olive's was in flight when the job ended, so it wasn't kept; Brock's started after, so it was.
    expect(calls('listTournaments')).toEqual([`listTournaments@${OLIVE.id}`]);
  });
});

describe('series from details', () => {
  beforeEach(() => onlyTcgChallenge());

  it('reads each tournament that could count once, and none that cannot', async () => {
    upstream.state.tournaments = [
      challenge('a', '2026-10-20T18:00:00Z'),
      challenge('b', '2026-11-14T18:00:00Z'),
      challenge('c', '2026-12-05T18:00:00Z'),
      challenge('other-group', '2026-11-14T18:00:00Z', { groupId: 'another-store' }),
      challenge('vgc', '2026-11-14T18:00:00Z', { products: ['vg'] }),
      challenge('january', '2027-01-09T18:00:00Z'),
      challenge('gone', '2026-11-15T18:00:00Z', { status: 'cancelled', applicationState: 'cancelled' }),
    ];
    await read();
    expect(calls('getTournament')).toHaveLength(3);
    reset();
    await read(true);
    expect(calls('getTournament')).toEqual([]);
  });

  it('reads one at a time and stops at the first 429, leaving the rest unread until the next request', async () => {
    service.requirements.update(L, service.requirements.active(L)[0]!.id, { minCount: 5 });
    upstream.state.tournaments = ['a', 'b', 'c', 'd', 'e'].map((id, i) => challenge(id, `2026-11-${10 + i}T18:00:00Z`));
    let reads = 0;
    let inFlight = 0;
    let most = 0;
    const base = upstream.gateway;
    upstream.gateway = (as) => ({
      ...base(as),
      getTournament: async (id) => {
        most = Math.max(most, ++inFlight);
        try {
          await Promise.resolve();
          if (++reads === 2) throw new PokemonUpstreamError('rate_limited', 'slow down');
          return await base(as).getTournament(id);
        } finally {
          inFlight--;
        }
      },
    });
    service = createTournamentsService({ db: database.db, connections: upstream.connections, gateway: upstream.gateway, timeZone: TZ, now: () => now });
    onlyTcgChallenge();

    const first = await nov();

    expect([reads, most]).toEqual([2, 1]);
    expect(first).toMatchObject({ status: 'unknown', bestKnown: 'missing' });
    expect(first.unreadTournaments.map((t) => t.tournamentId)).toEqual(['b', 'c', 'd', 'e']);
    const second = await nov();
    expect(reads).toBe(6);
    expect(second.status).toBe('sanctioned');
  });

  it('makes the period unknown while a details read failed, and retries it next time', async () => {
    upstream.state.tournaments = [challenge('a')];
    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('unavailable', 'down'));
    expect(await nov()).toMatchObject({ status: 'unknown', bestKnown: 'missing', unreadTournaments: [{ tournamentId: 'a', displayId: '26-10-a' }] });
    expect(await nov()).toMatchObject({ status: 'sanctioned' });
  });

  it('fills a series name the details leave out from the series list', async () => {
    upstream.state.series = [series('lc-nov', 'League Challenge November', '2026-11-01', '2026-11-30')];
    upstream.state.tournaments = [challenge('a', '2026-11-14T18:00:00Z', { details: { series: { id: 'lc-nov', name: null } } })];
    expect((await nov()).status).toBe('sanctioned');
  });
});

describe('series windows', () => {
  beforeEach(() => onlyTcgChallenge());

  it('takes windows from the first connected professor whose series read succeeds', async () => {
    upstream.state.failNext.set(`listSeries@${OLIVE.id}`, new PokemonUpstreamError('unavailable', 'down'));
    upstream.state.series = [series('lc', 'League Challenge', '2026-11-01', '2026-11-20')];
    const result = await read();
    expect(result.seriesUnavailable).toBe(false);
    expect(result.requirements[0]!.periods.find((p) => p.periodStart === '2026-11-01')!.latestDate).toBe('2026-11-20');
  });

  it('says the series are unavailable when nobody can read them, and still answers', async () => {
    upstream.state.failNext.set(`listSeries@${OLIVE.id}`, new PokemonUpstreamError('unavailable', 'down'));
    upstream.state.failNext.set(`listSeries@${BROCK.id}`, new PokemonUpstreamError('unavailable', 'down'));
    const result = await read();
    expect(result.seriesUnavailable).toBe(true);
    expect(result.requirements[0]!.periods.find((p) => p.periodStart === '2026-11-01')).toMatchObject({ latestDate: '2026-11-30', noSeries: false });
  });
});

describe('planned tournaments', () => {
  beforeEach(() => onlyTcgChallenge());

  it("counts a premier row its organizer's series resolve, from the creatable window on", async () => {
    upstream.state.series = [series('lc', 'League Challenge', '2026-11-01', '2026-11-30')];
    const template = service.createTemplate(L, templateBody(), OWNER);
    const row = service.createPlanned(L, { templateId: template.id, localDate: '2026-11-14' });
    expect(await nov()).toMatchObject({ status: 'planned', action: { kind: 'create', plannedId: row.plannedId } });
  });

  it('counts rows from today − 2 on, in every state a create can still be in, by the league date of their start', async () => {
    upstream.state.series = [series('lc', 'League Challenge', '2026-10-01', '2026-11-30')];
    const template = service.createTemplate(L, templateBody(), OWNER);
    const at = (localDate: string, state: string) => {
      const row = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-20', startTime: `1${state.length % 10}:00` });
      database.sqlite.prepare('update planned_tournament set local_date = ?, state = ? where id = ?').run(localDate, state, row.plannedId);
      return row.plannedId!;
    };
    const twoDaysBack = at('2026-10-12', 'failed');
    at('2026-10-11', 'planned'); // today − 3: too late to create
    const creating = at('2026-10-25', 'creating');
    const unknown = at('2026-10-26', 'unknown');

    const october = (await read()).requirements[0]!.periods.find((p) => p.periodStart === '2026-10-01')!;

    expect(october.tournaments.map((t) => t.plannedId).sort()).toEqual([twoDaysBack, creating, unknown].sort());
  });

  it("puts a row in the period of its start's date in the league time zone, not the venue's", async () => {
    upstream.state.series = [series('lc', 'League Challenge', '2026-10-01', '2026-11-30')];
    const west = { ...templateBody().venue, timeZone: 'America/Los_Angeles' };
    const template = service.createTemplate(L, templateBody({ venue: west, startTime: '23:30' }), OWNER);
    // 23:30 on Oct 31 in Los Angeles is 01:30 on Nov 1 in Chicago.
    const row = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-31' });

    const periods = (await read()).requirements[0]!.periods;

    expect(periods.find((p) => p.periodStart === '2026-11-01')!.tournaments.map((t) => t.plannedId)).toEqual([row.plannedId]);
    expect(periods.find((p) => p.periodStart === '2026-10-01')!.tournaments).toEqual([]);
  });

  it("falls back to the template's match when its organizer's series can't be read", async () => {
    const template = service.createTemplate(L, templateBody(), OWNER);
    service.createPlanned(L, { templateId: template.id, localDate: '2026-11-14' });
    seriesDown();
    expect((await nov()).status).toBe('planned');
  });

  it("can't judge a row with a series pick when its organizer's series can't be read, so the period is unknown", async () => {
    upstream.state.series = [series('lc', 'League Challenge', '2026-11-01', '2026-11-30')];
    const template = service.createTemplate(L, templateBody(), OWNER);
    const row = service.createPlanned(L, { templateId: template.id, localDate: '2026-11-14' });
    service.updatePlanned(L, row.plannedId!, { seriesId: 'lc' }, OWNER);
    seriesDown();
    expect(await nov()).toMatchObject({ status: 'unknown', unjudgedPlanned: [row.plannedId] });
  });

  it('links an unknown row to the tournament the listing shows, so it never counts twice', async () => {
    service.requirements.update(L, service.requirements.active(L)[0]!.id, { minCount: 2 });
    upstream.state.series = [series('lc', 'League Challenge', '2026-11-01', '2026-11-30')];
    const template = service.createTemplate(L, templateBody({ name: 'League Challenge' }), OWNER);
    const row = service.createPlanned(L, { templateId: template.id, localDate: '2026-11-14' });
    database.sqlite.prepare("update planned_tournament set state = 'unknown' where id = ?").run(row.plannedId);
    // 18:00 in Chicago on Nov 14 is 00:00Z on Nov 15.
    upstream.state.tournaments = [challenge('landed', '2026-11-15T00:00:00Z', { name: 'League Challenge' })];

    expect(await nov()).toMatchObject({ status: 'missing', tournaments: [{ tournamentId: 'landed', class: 'sanctioned' }] });
    expect(database.sqlite.prepare('select state, tournament_id from planned_tournament where id = ?').get(row.plannedId)).toEqual({ state: 'created', tournament_id: 'landed' });
  });

  it('never counts a custom row, a skipped one, or one already in play-tools', async () => {
    upstream.state.series = [series('lc', 'League Challenge', '2026-11-01', '2026-11-30')];
    const custom = service.createTemplate(L, templateBody({ type: { kind: 'custom' }, name: 'Friday {date}' }), OWNER);
    service.createPlanned(L, { templateId: custom.id, localDate: '2026-11-14' });
    const premier = service.createTemplate(L, templateBody({ name: 'LC {month}' }), OWNER);
    const skipped = service.createPlanned(L, { templateId: premier.id, localDate: '2026-11-15' });
    const created = service.createPlanned(L, { templateId: premier.id, localDate: '2026-11-16' });
    database.sqlite.prepare("update planned_tournament set state = 'skipped' where id = ?").run(skipped.plannedId);
    database.sqlite.prepare("update planned_tournament set state = 'created', tournament_id = 'elsewhere' where id = ?").run(created.plannedId);
    expect((await nov()).status).toBe('missing');
  });

  it('follows a one-off’s own type: a premier template changed to Custom covers nothing (#162)', async () => {
    upstream.state.series = [series('lc', 'League Challenge', '2026-11-01', '2026-11-30')];
    const template = service.createTemplate(L, templateBody(), OWNER);
    const custom = service.createPlanned(L, { templateId: template.id, localDate: '2026-11-14', seriesId: 'custom' });
    expect((await nov()).status).toBe('missing');
    database.sqlite.prepare('update planned_tournament set series_override = null where id = ?').run(custom.plannedId);
    expect((await nov(true)).status).toBe('planned');
  });

  it('judges a one-off’s series by its own venue’s country, as creation does (#162)', async () => {
    upstream.state.series = [series('lc', 'League Challenge', '2026-11-01', '2026-11-30')];
    const template = service.createTemplate(L, templateBody(), OWNER);
    const abroad = { id: '00000000-0000-4000-8000-000000000053', label: 'Toronto Shop', timeZone: 'America/Toronto', country: 'CA' };
    service.createPlanned(L, { templateId: template.id, localDate: '2026-11-14', overrides: { venue: abroad } });
    // The series has a US window only, so nothing resolves for a Canadian venue.
    expect((await nov()).status).toBe('missing');
  });
});

describe('failures that never show missing, and never keep play-tools busy (PR review)', () => {
  beforeEach(() => onlyTcgChallenge());

  it("treats a nameless series as unread when the series list couldn't be read", async () => {
    upstream.state.tournaments = [challenge('a', '2026-11-14T18:00:00Z', { details: { series: { id: 'lc-nov', name: null } } })];
    seriesDown();
    expect(await nov()).toMatchObject({ status: 'unknown', bestKnown: 'missing', unreadTournaments: [{ tournamentId: 'a' }] });
  });

  it('remembers a details failure that is not a 429 or 5xx until the listings are next read', async () => {
    upstream.state.tournaments = [challenge('a')];
    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('forbidden', 'Request not authorized for attempted action.'));
    expect((await nov()).status).toBe('unknown');
    reset();
    expect((await nov()).status).toBe('unknown');
    expect(calls('getTournament')).toEqual([]);
    now = new Date(NOON_WED.getTime() + 5 * MINUTE);
    expect((await nov()).status).toBe('sanctioned');
    expect(calls('getTournament')).toHaveLength(1);
  });

  it('forgets a remembered details failure when a tournament job ends', async () => {
    upstream.state.tournaments = [challenge('a')];
    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('not_found', 'gone'));
    await nov();
    service.requiredEvents.listingsChanged();
    expect((await nov()).status).toBe('sanctioned');
  });

  it('leaves linking unknown rows to the next request after a details 429', async () => {
    upstream.state.series = [series('lc', 'League Challenge', '2026-11-01', '2026-11-30')];
    const template = service.createTemplate(L, templateBody({ name: 'League Challenge' }), OWNER);
    const row = service.createPlanned(L, { templateId: template.id, localDate: '2026-11-14' });
    database.sqlite.prepare("update planned_tournament set state = 'unknown' where id = ?").run(row.plannedId);
    upstream.state.tournaments = [challenge('landed', '2026-11-15T00:00:00Z', { name: 'League Challenge' })];
    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('rate_limited', 'slow down'));

    await nov();

    expect(calls('getTournament')).toHaveLength(1);
    expect(database.sqlite.prepare('select state from planned_tournament where id = ?').get(row.plannedId)).toEqual({ state: 'unknown' });
    reset();
    await nov();
    expect(database.sqlite.prepare('select state from planned_tournament where id = ?').get(row.plannedId)).toEqual({ state: 'created' });
  });
});
