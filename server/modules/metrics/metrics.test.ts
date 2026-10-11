import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type RosterService, createRosterService } from '../roster/service';
import { type MetricsService, createMetricsService } from './metrics';
import { type SightingKind, type SightingsService, createSightingsService } from './sightings';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const id = (s: string) => s as PlayerId;
const d = (s: string) => s as SessionDate;

/** Wednesdays, oldest first; TODAY is the last one. */
const WEDS = ['2026-08-19', '2026-08-26', '2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30', '2026-10-07', '2026-10-14'].map(d);
const TODAY = d('2026-10-14');

let database: OpenDatabase;
let sightings: SightingsService;
let timesSubmitted: Map<PlayerId, number>;
let metrics: MetricsService;
let roster: RosterService;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  createRosterService({ db: database.db }).ensurePlayers(L, ['1', '2', '3'].map((p) => ({ playerId: id(p) })));
  sightings = createSightingsService({ db: database.db });
  timesSubmitted = new Map();
  roster = createRosterService({ db: database.db });
  metrics = createMetricsService({ db: database.db, roster, submissions: { timesSubmitted: () => timesSubmitted } });
});
afterEach(() => database.close());

const see = (playerId: string, dates: readonly SessionDate[], kind: SightingKind = 'tdf') => {
  for (const date of dates) sightings.record(L, date, kind, [id(playerId)]);
};
const of = (playerId: string, today = TODAY) => metrics.forLeague(L, today).get(id(playerId));

describe('player metrics', () => {
  it('counts distinct session dates, however many kinds of evidence a date has', () => {
    see('1', [WEDS[0]!, WEDS[1]!], 'tdf');
    see('1', [WEDS[1]!], 'manual');
    see('1', [WEDS[1]!], 'upstream_existing');

    expect(of('1')?.sightingsTotal).toBe(2);
  });

  it('counts sightings in the last 4, 8 and 12 weeks; a date exactly N weeks back is outside the window', () => {
    see('1', [d('2026-07-22'), d('2026-07-23'), ...WEDS]); // 2026-07-22 is 12 weeks before TODAY

    expect(of('1')).toMatchObject({ sightingsTotal: 11, sightings4w: 4, sightings8w: 8, sightings12w: 10 });
  });

  it('knows when a player was first and last seen', () => {
    see('1', [WEDS[2]!, WEDS[0]!, WEDS[5]!]);

    expect(of('1')).toMatchObject({ firstSeen: WEDS[0], lastSeen: WEDS[5] });
  });

  it('rates attendance over the league sessions held in the last 8 weeks (any sighting on a date means a session was held)', () => {
    see('2', WEDS); // 9 dates; the 8-week window holds the last 8
    see('1', [WEDS[0]!, WEDS[5]!, WEDS[8]!]); // WEDS[0] is outside the window

    expect(of('1')?.attendanceRate8w).toBe(2 / 8);
    expect(of('2')?.attendanceRate8w).toBe(1);
  });

  it('has no attendance rate when the league held no session in the last 8 weeks', () => {
    see('1', [d('2026-01-07')]);

    expect(of('1')).toMatchObject({ sightingsTotal: 1, sightings8w: 0, attendanceRate8w: null });
  });

  it('counts the current streak of consecutive league sessions, back from the latest', () => {
    see('2', WEDS);
    see('1', [...WEDS.slice(0, 4), ...WEDS.slice(6)]); // missed WEDS[4] and WEDS[5]
    see('3', [WEDS[2]!, WEDS[4]!]);

    expect(of('1')).toMatchObject({ currentStreak: 3, sessionsSinceLastSeen: 0 });
    expect(of('2')).toMatchObject({ currentStreak: 9, sessionsSinceLastSeen: 0 });
    expect(of('3')).toMatchObject({ currentStreak: 0, sessionsSinceLastSeen: 4 });
  });

  it('counts sessions, not weeks: a skipped week breaks no streak', () => {
    see('1', [WEDS[0]!, WEDS[2]!, WEDS[8]!]); // the league only met on these dates

    expect(of('1')).toMatchObject({ currentStreak: 3, sessionsSinceLastSeen: 0 });
  });

  it('counts sessions since the last tdf or manual sighting; being already recorded upstream is not presence', () => {
    see('2', WEDS);
    see('1', [WEDS[1]!], 'manual');
    see('1', [WEDS[3]!], 'tdf');
    see('1', [WEDS[7]!], 'upstream_existing');
    see('3', [WEDS[8]!], 'upstream_existing');

    expect(of('1')).toMatchObject({ lastSeen: WEDS[7], sessionsSinceLastSeen: 1, sessionsSinceLastPresent: 5 });
    expect(of('2')).toMatchObject({ sessionsSinceLastPresent: 0 });
    expect(of('3')).toMatchObject({ sessionsSinceLastSeen: 0, sessionsSinceLastPresent: null });
  });

  it('ignores sightings after today', () => {
    see('1', [WEDS[7]!, d('2026-10-21')]);

    expect(of('1')).toMatchObject({ sightingsTotal: 1, sightings4w: 1 });
    expect(of('1', d('2026-10-21'))).toMatchObject({ sightingsTotal: 2 });
  });

  it('keeps leagues apart', () => {
    database.sqlite.prepare("insert into league (id, name) values ('other', 'Other')").run();
    sightings.record('other', WEDS[0]!, 'tdf', [id('2')]);
    see('1', [WEDS[1]!]);

    expect(metrics.forLeague(L, TODAY).has(id('2'))).toBe(false);
    expect(metrics.forLeague('other', TODAY).get(id('2'))).toMatchObject({ sightingsTotal: 1 });
  });
});

describe('curation thresholds', () => {
  it('defaults to promoting at 4 sightings in 8 weeks and flagging regulars unseen for 6 sessions', () => {
    expect(metrics.getThresholds(L)).toEqual({ promoteMinSightings: 4, staleAfterSessions: 6 });
  });

  it('keeps what the organizer sets, per league', () => {
    database.sqlite.prepare("insert into league (id, name) values ('other', 'Other')").run();

    expect(metrics.setThresholds(L, { promoteMinSightings: 3, staleAfterSessions: 10 })).toEqual({ promoteMinSightings: 3, staleAfterSessions: 10 });
    metrics.setThresholds(L, { promoteMinSightings: 5, staleAfterSessions: 8 });

    expect(metrics.getThresholds(L)).toEqual({ promoteMinSightings: 5, staleAfterSessions: 8 });
    expect(metrics.getThresholds('other')).toEqual({ promoteMinSightings: 4, staleAfterSessions: 6 });
  });
});

describe('regulars with metrics', () => {
  it('lists only regulars, by name, each with metrics and the stale flag', () => {
    roster.addRegular(L, { playerId: id('1'), name: 'Misty' });
    roster.addRegular(L, { playerId: id('2'), name: 'Brock' });
    see('3', WEDS);
    see('1', [WEDS[8]!]);

    expect(metrics.listRegulars(L, TODAY)).toEqual([
      expect.objectContaining({ playerId: '2', displayName: 'Brock', regularSince: expect.any(Date), metrics: null, stale: true }),
      expect.objectContaining({ playerId: '1', metrics: expect.objectContaining({ lastSeen: WEDS[8] }), stale: false }),
    ]);
  });
});

describe('curated player list', () => {
  const ids = (players: { playerId: string }[]) => players.map((p) => p.playerId);
  const regular = (playerId: string, name?: string) => roster.addRegular(L, { playerId: id(playerId), name });
  const player = (playerId: string, name?: string) => roster.ensurePlayers(L, [{ playerId: id(playerId), name }]);

  describe('all', () => {
    it('lists every known player by name, with metrics (null when never seen), times submitted and both flags', () => {
      player('1', 'Misty');
      player('2', 'Brock');
      see('1', [WEDS[8]!]);
      timesSubmitted.set(id('2'), 3);

      const players = metrics.listPlayers(L, { filter: 'all', today: TODAY });

      expect(ids(players)).toEqual(['3', '2', '1']); // no name sorts first
      expect(players.find((p) => p.playerId === '1')).toMatchObject({
        displayName: 'Misty',
        isRegular: false,
        metrics: { sightingsTotal: 1, lastSeen: WEDS[8] },
        timesSubmitted: 0,
        promotionCandidate: false,
        stale: false,
      });
      expect(players.find((p) => p.playerId === '2')).toMatchObject({ metrics: null, timesSubmitted: 3 });
    });

    it('searches by name or id', () => {
      player('1', 'Misty');
      player('2', 'Brock');

      expect(ids(metrics.listPlayers(L, { filter: 'all', q: 'mis', today: TODAY }))).toEqual(['1']);
    });
  });

  describe('promote', () => {
    it('lists non-regulars seen at least the threshold in the last 8 weeks, most seen first', () => {
      player('1', 'Ash');
      player('2', 'Brock');
      player('4', 'Dawn');
      regular('3', 'Misty');
      see('1', WEDS.slice(4)); // 5 in 8 weeks
      see('2', [WEDS[0]!, ...WEDS.slice(6)]); // WEDS[0] is outside the window: 3
      see('4', WEDS.slice(3)); // 6
      see('3', WEDS); // a regular is never a candidate

      expect(ids(metrics.listPlayers(L, { filter: 'promote', today: TODAY }))).toEqual(['4', '1']);

      metrics.setThresholds(L, { promoteMinSightings: 3, staleAfterSessions: 6 });
      const players = metrics.listPlayers(L, { filter: 'promote', today: TODAY });
      expect(ids(players)).toEqual(['4', '1', '2']);
      expect(players.every((p) => p.promotionCandidate)).toBe(true);
    });
  });

  describe('stale', () => {
    beforeEach(() => {
      player('9', 'Every week');
      see('9', WEDS); // 9 sessions held
    });

    it('lists regulars with no tdf or manual sighting in the last N sessions, longest absent first', () => {
      regular('1', 'Here');
      regular('2', 'Gone');
      regular('3', 'Upstream only');
      regular('4', 'Never seen');
      regular('5', 'Just in time');
      player('6', 'Not a regular');
      see('1', [WEDS[8]!], 'manual');
      see('2', [WEDS[2]!], 'tdf'); // 6 sessions since
      see('3', WEDS, 'upstream_existing');
      see('5', [WEDS[3]!], 'tdf'); // 5 sessions since

      const players = metrics.listPlayers(L, { filter: 'stale', today: TODAY });

      expect(ids(players)).toEqual(['4', '3', '2']); // never present, by name; then longest absent
      expect(players.every((p) => p.stale)).toBe(true);
    });

    it('flags nobody until the league has held N sessions', () => {
      regular('1', 'Never seen');
      metrics.setThresholds(L, { promoteMinSightings: 4, staleAfterSessions: 10 });

      expect(metrics.listPlayers(L, { filter: 'stale', today: TODAY })).toEqual([]);

      metrics.setThresholds(L, { promoteMinSightings: 4, staleAfterSessions: 9 });
      expect(ids(metrics.listPlayers(L, { filter: 'stale', today: TODAY }))).toEqual(['1']);
    });
  });
});
