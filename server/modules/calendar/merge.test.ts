import { describe, expect, it } from 'vitest';
import type { CalendarCheck, CalendarRead } from '../tournaments/service';
import { type SessionsRead, dropOuts, merge } from './merge';
import type { Snapshot, SnapshotEvent } from './snapshot';
import { BROCK, LEAGUE, MISTY, OAK, calendarTournament, localRead, playSession, refreshRead, upstreamOnly } from './test-helpers';

// The rules that keep a feed from cancelling an event that isn't off (ADR-0016 §3 and §5): a refresh or a local
// rebuild merged into the previous snapshot. Pure: every case is a previous snapshot, a read and the details answers.

const NOW = new Date('2026-10-20T15:00:00Z');
const RANGE = { from: new Date('2026-09-20T05:00:00Z'), to: new Date('2027-04-21T05:00:00Z') };
const NAMES = new Map([
  [OAK, 'Prof Oak'],
  [MISTY, 'Misty'],
  [BROCK, 'Brock'],
]);
const NO_SESSIONS: SessionsRead = { ok: true, sessions: [] };

function run(
  previous: Snapshot | null,
  read: CalendarRead,
  opts: { sessions?: SessionsRead | null; checks?: Record<string, CalendarCheck>; now?: Date } = {},
) {
  const asked = dropOuts(previous, read, RANGE);
  const snapshot = merge(previous, {
    leagueId: LEAGUE,
    now: opts.now ?? NOW,
    range: RANGE,
    read,
    sessions: opts.sessions === undefined ? (read.upstream === 'local' ? null : NO_SESSIONS) : opts.sessions,
    checks: new Map(Object.entries(opts.checks ?? {})),
    names: NAMES,
  });
  return { snapshot, asked };
}

const event = (s: Snapshot, uidStart: string) => s.events.find((e) => e.uid.startsWith(uidStart));
const uids = (s: Snapshot) => s.events.map((e) => e.uid).sort();
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe('a first refresh', () => {
  it('builds each event with a UID from what it was first seen as, the default lengths, and its source', () => {
    const t1 = calendarTournament();
    const t2 = upstreamOnly('g2', MISTY, { name: null, applicationState: 'approval-pending' });
    const p1 = calendarTournament({ plannedId: 7, tournamentId: null, state: 'planned', organizerPlayerId: MISTY, listedBy: null, applicationState: null, name: 'P1' });
    const s1 = playSession('s1', '2026-10-22T23:00:00Z', { status: 'active', endsAt: new Date('2026-10-23T02:00:00Z') });

    const { snapshot } = run(null, refreshRead([t1, t2, p1], { read: [OAK, MISTY] }), { sessions: { ok: true, sessions: [s1] } });

    expect(snapshot.builtAt).toBe(NOW.toISOString());
    expect(uids(snapshot)).toEqual([
      'planned-1@default.play-pokemon-attendance',
      'planned-7@default.play-pokemon-attendance',
      'session-s1@default.play-pokemon-attendance',
      'tournament-g2@default.play-pokemon-attendance',
    ]);
    expect(event(snapshot, 'planned-1')).toMatchObject({
      kind: 'tournament',
      source: `professor:${OAK}`,
      sourceConfirmed: true,
      created: true,
      name: "Ettin's November TCG Challenge",
      startsAt: '2026-11-07T19:00:00.000Z',
      endsAt: '2026-11-07T23:00:00.000Z',
      location: 'Cerulean Gym',
      details: ['TCG', 'Event website: https://example.test/t1'],
      url: 'https://example.test/t1',
      tentative: false,
      cancelled: false,
      lastModified: NOW.toISOString(),
    });
    expect(event(snapshot, 'tournament-g2')).toMatchObject({ name: 'TCG tournament', tentative: true, location: null, source: `professor:${MISTY}` });
    expect(event(snapshot, 'planned-7')).toMatchObject({ created: false, tentative: true, sourceConfirmed: false, source: `professor:${MISTY}` });
    expect(event(snapshot, 'session-s1')).toMatchObject({
      kind: 'session',
      name: 'Open play · TCG, VG',
      endsAt: '2026-10-23T02:00:00.000Z',
      source: 'sessions',
      created: true,
      tentative: false,
    });
    expect(snapshot.sources).toEqual(
      expect.arrayContaining([
        { key: `professor:${OAK}`, name: 'Prof Oak', lastReadAt: NOW.toISOString(), lastAttemptAt: NOW.toISOString(), lastError: null },
        { key: 'sessions', name: null, lastReadAt: NOW.toISOString(), lastAttemptAt: NOW.toISOString(), lastError: null },
      ]),
    );
  });

  it('gives a session with no end three hours, and a tournament with no single game a plain title', () => {
    const { snapshot } = run(null, refreshRead([upstreamOnly('g3', OAK, { name: null, product: null })]), {
      sessions: { ok: true, sessions: [playSession('s2', '2026-10-29T23:00:00Z')] },
    });

    expect(event(snapshot, 'session-s2')!.endsAt).toBe('2026-10-30T02:00:00.000Z');
    expect(event(snapshot, 'tournament-g3')).toMatchObject({ name: 'Tournament', details: [] });
  });

  it('describes on-site and third-party registration', () => {
    const onSite = calendarTournament({ registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: '$5' }, eventWebsite: null });
    const thirdParty = calendarTournament({
      plannedId: 2,
      tournamentId: 'g9',
      registration: { kind: 'third_party', url: 'https://reg.example.test' },
      eventWebsite: null,
    });

    const { snapshot } = run(null, refreshRead([onSite, thirdParty]));

    expect(event(snapshot, 'planned-1')!.details).toEqual(['TCG', 'Registration on site opens 60 min before the start and closes 15 min after. Admission: $5']);
    expect(event(snapshot, 'planned-2')!.details).toEqual(['TCG', 'Registration: https://reg.example.test']);
  });
});

describe('updates in place', () => {
  it('keeps LAST-MODIFIED while nothing shown changes, and moves it when the start does, under the same UID', () => {
    const first = run(null, refreshRead([calendarTournament()])).snapshot;

    const same = run(first, refreshRead([calendarTournament()]), { now: later(60) }).snapshot;
    expect(event(same, 'planned-1')!.lastModified).toBe(NOW.toISOString());
    expect(same.builtAt).toBe(later(60).toISOString());

    const moved = run(same, refreshRead([calendarTournament({ startsAt: '2026-11-07T20:00:00.000Z' })]), { now: later(120) }).snapshot;
    expect(event(moved, 'planned-1')).toMatchObject({ startsAt: '2026-11-07T20:00:00.000Z', lastModified: later(120).toISOString() });
    expect(uids(moved)).toEqual(['planned-1@default.play-pokemon-attendance']);
  });

  it('keeps the planned UID when the row is created in play-tools', () => {
    const planned = calendarTournament({ tournamentId: null, state: 'planned', listedBy: null, applicationState: null });
    const first = run(null, localRead([planned])).snapshot;

    const created = run(first, refreshRead([calendarTournament({ applicationState: 'approval-pending' })])).snapshot;

    expect(uids(created)).toEqual(['planned-1@default.play-pokemon-attendance']);
    expect(event(created, 'planned-1')).toMatchObject({ created: true, tentative: true, tournamentId: 'g1' });
  });

  it('keeps the tournament UID when a planned row adopts a tournament already published', () => {
    const first = run(null, refreshRead([upstreamOnly('g2', MISTY)])).snapshot;

    const adopted = run(first, refreshRead([calendarTournament({ plannedId: 4, tournamentId: 'g2', listedBy: MISTY, organizerPlayerId: MISTY })])).snapshot;

    expect(uids(adopted)).toEqual(['tournament-g2@default.play-pokemon-attendance']);
    expect(event(adopted, 'tournament-g2')).toMatchObject({ plannedId: 4, location: 'Cerulean Gym' });
  });

  it('keeps only the tournament UID when a row links to a tournament a refresh listed while the row was being created', () => {
    const creating = calendarTournament({ tournamentId: null, state: 'creating', listedBy: null, applicationState: null });
    const first = run(null, refreshRead([creating, upstreamOnly('g1', OAK, { applicationState: 'approval-pending' })])).snapshot;
    expect(uids(first)).toEqual(['planned-1@default.play-pokemon-attendance', 'tournament-g1@default.play-pokemon-attendance']);

    const linked = run(first, localRead([calendarTournament()])).snapshot;

    expect(uids(linked)).toEqual(['tournament-g1@default.play-pokemon-attendance']);
    expect(event(linked, 'tournament-g1')).toMatchObject({ plannedId: 1, location: 'Cerulean Gym' });
  });
});

describe('the sanctioning state', () => {
  it('stays through a local rebuild, which has no listing, with LAST-MODIFIED unchanged', () => {
    const first = run(null, refreshRead([calendarTournament({ applicationState: 'approval-pending' })])).snapshot;

    const rebuilt = run(first, localRead([calendarTournament()]), { now: later(5) }).snapshot;

    expect(event(rebuilt, 'planned-1')).toMatchObject({ tentative: true, applicationState: 'approval-pending', lastModified: NOW.toISOString() });
  });

  it('makes a tournament no listing has reported yet tentative, and confirmed once a listing says sanctioned', () => {
    const justCreated = run(null, localRead([calendarTournament()])).snapshot;
    expect(event(justCreated, 'planned-1')!.tentative).toBe(true);

    const sanctioned = run(justCreated, refreshRead([calendarTournament()]), { now: later(60) }).snapshot;
    expect(event(sanctioned, 'planned-1')).toMatchObject({ tentative: false, lastModified: later(60).toISOString() });
  });
});

describe('a tournament that dropped out of its listing', () => {
  const published = () => run(null, refreshRead([calendarTournament(), upstreamOnly('g2', MISTY)])).snapshot;
  const withoutG2 = () => refreshRead([calendarTournament()], { read: [OAK, MISTY] });

  it('gets one details read as its source, and is cancelled when play-tools says it is off', () => {
    const { snapshot, asked } = run(published(), withoutG2(), { checks: { g2: { kind: 'cancelled' } } });

    expect(asked).toEqual([{ tournamentId: 'g2', playerId: MISTY }]);
    expect(event(snapshot, 'tournament-g2')).toMatchObject({ cancelled: true, lastModified: NOW.toISOString() });
  });

  it('leaves without a cancellation when it was rescheduled out of the range', () => {
    const { snapshot } = run(published(), withoutG2(), { checks: { g2: { kind: 'exists', startsAt: '2027-06-01T16:00:00.000Z' } } });

    expect(event(snapshot, 'tournament-g2')).toBeUndefined();
  });

  it.each<[string, CalendarCheck | undefined]>([
    ['the details read failed', { kind: 'unreadable' }],
    ['it still exists in the range', { kind: 'exists', startsAt: '2026-11-07T19:00:00.000Z' }],
    ['no details read was made', undefined],
  ])('is kept unchanged when %s', (_, check) => {
    const before = published();
    const { snapshot } = run(before, withoutG2(), { checks: check ? { g2: check } : {}, now: later(60) });

    expect(event(snapshot, 'tournament-g2')).toEqual(event(before, 'tournament-g2'));
  });

  it('is checked for a tournament the app planned too, and cancelled', () => {
    const before = published();
    const read = refreshRead([calendarTournament({ listedBy: null, applicationState: null }), upstreamOnly('g2', MISTY)], { read: [OAK, MISTY] });

    const { snapshot, asked } = run(before, read, { checks: { g1: { kind: 'cancelled' } } });

    expect(asked).toEqual([{ tournamentId: 'g1', playerId: OAK }]);
    expect(event(snapshot, 'planned-1')).toMatchObject({ cancelled: true });
  });
});

describe('never a false cancellation', () => {
  const published = () => run(null, refreshRead([calendarTournament(), upstreamOnly('g2', MISTY)])).snapshot;

  it.each<[string, CalendarRead]>([
    ['its source failed', refreshRead([calendarTournament()], { read: [OAK], failed: [{ playerId: MISTY, code: 'needs_reconnect' }] })],
    ['its source is gone', refreshRead([calendarTournament()], { read: [OAK] })],
    ['a connection has no player ID', refreshRead([calendarTournament()], { read: [OAK, MISTY], unmatched: true })],
    ['no league is chosen', { ...refreshRead([calendarTournament()]), upstream: 'league_not_selected', read: [] }],
    ['the read was local', localRead([calendarTournament()])],
  ])('asks nothing and keeps the event unchanged when %s', (_, read) => {
    const before = published();
    const { snapshot, asked } = run(before, read, { now: later(60) });

    expect(asked).toEqual([]);
    expect(event(snapshot, 'tournament-g2')).toEqual(event(before, 'tournament-g2'));
  });

  it("never checks a tournament no listing has held yet, the app's own just created", () => {
    const before = run(null, localRead([calendarTournament()])).snapshot;

    const { asked, snapshot } = run(before, refreshRead([calendarTournament({ listedBy: null, applicationState: null })], { read: [OAK] }));

    expect(asked).toEqual([]);
    expect(event(snapshot, 'planned-1')!.cancelled).toBe(false);
  });

  it("checks as the professor whose listing held it, not the template's new organizer", () => {
    const before = published();
    const movedToBrock = calendarTournament({ organizerPlayerId: BROCK });

    const stillListed = run(before, refreshRead([movedToBrock, upstreamOnly('g2', MISTY)], { read: [OAK, MISTY, BROCK] }));
    expect(stillListed.asked).toEqual([]);
    expect(event(stillListed.snapshot, 'planned-1')).toMatchObject({ source: `professor:${OAK}`, cancelled: false });

    const dropped = run(stillListed.snapshot, refreshRead([{ ...movedToBrock, listedBy: null }, upstreamOnly('g2', MISTY)], { read: [OAK, MISTY, BROCK] }));
    expect(dropped.asked).toEqual([{ tournamentId: 'g1', playerId: OAK }]);
  });

  it('never checks a tournament whose last known start is outside the range', () => {
    const before = run(null, refreshRead([upstreamOnly('g5', MISTY, { startsAt: '2026-09-01T16:00:00.000Z' })])).snapshot;

    expect(run(before, refreshRead([], { read: [MISTY] })).asked).toEqual([]);
  });
});

describe('planned rows', () => {
  const p1 = (overrides = {}) =>
    calendarTournament({ plannedId: 7, tournamentId: null, state: 'planned', organizerPlayerId: MISTY, listedBy: null, applicationState: null, ...overrides });

  it('shows a published row that becomes skipped as cancelled, and back under the same UID when unskipped', () => {
    const first = run(null, localRead([p1()])).snapshot;

    const skipped = run(first, localRead([p1({ state: 'skipped' })])).snapshot;
    expect(event(skipped, 'planned-7')).toMatchObject({ cancelled: true });

    const unskipped = run(skipped, localRead([p1()])).snapshot;
    expect(event(unskipped, 'planned-7')).toMatchObject({ cancelled: false });
  });

  it('never shows a row skipped or cancelled before any snapshot held it', () => {
    expect(run(null, localRead([p1({ state: 'skipped' }), p1({ plannedId: 8, state: 'cancelled' })])).snapshot.events).toEqual([]);
  });

  it('shows a published row the app cancelled as cancelled', () => {
    const first = run(null, refreshRead([calendarTournament()])).snapshot;

    const cancelled = run(first, localRead([calendarTournament({ state: 'cancelled' })])).snapshot;

    expect(event(cancelled, 'planned-1')).toMatchObject({ cancelled: true, created: true });
  });

  it('keeps the published version of a row whose new time a DST change skips, and adds no new row with one', () => {
    const first = run(null, localRead([p1()])).snapshot;

    const broken = run(first, localRead([p1({ startsAt: null, timeProblem: 'nonexistent' }), p1({ plannedId: 9, startsAt: null, timeProblem: 'ambiguous' })])).snapshot;

    expect(event(broken, 'planned-7')).toEqual(event(first, 'planned-7'));
    expect(event(broken, 'planned-9')).toBeUndefined();
  });

  it('drops a planned row that no longer exists, without a cancellation', () => {
    const first = run(null, localRead([p1()])).snapshot;

    expect(run(first, localRead([])).snapshot.events).toEqual([]);
  });
});

describe('play sessions', () => {
  const s1 = playSession('s1', '2026-10-22T23:00:00Z', { status: 'active' });
  const s2 = playSession('s2', '2026-10-29T23:00:00Z');

  it('cancels a published session missing from a successful listing, and brings it back under the same UID', () => {
    const first = run(null, refreshRead([]), { sessions: { ok: true, sessions: [s1, s2] } }).snapshot;

    const gone = run(first, refreshRead([]), { sessions: { ok: true, sessions: [s2] } }).snapshot;
    expect(event(gone, 'session-s1')).toMatchObject({ cancelled: true });

    const back = run(gone, refreshRead([]), { sessions: { ok: true, sessions: [s1, s2] } }).snapshot;
    expect(event(back, 'session-s1')).toMatchObject({ cancelled: false });
  });

  it('keeps every session unchanged when the listing failed or was not made', () => {
    const first = run(null, refreshRead([]), { sessions: { ok: true, sessions: [s1, s2] } }).snapshot;

    for (const sessions of [{ ok: false as const, code: 'unavailable' }, null]) {
      const kept = run(first, refreshRead([]), { sessions, now: later(60) }).snapshot;
      expect(kept.events.filter((e) => e.kind === 'session')).toEqual(first.events);
    }
  });

  it('records a failed listing on the sessions source and keeps its last read', () => {
    const first = run(null, refreshRead([]), { sessions: { ok: true, sessions: [s1] } }).snapshot;

    const failed = run(first, refreshRead([]), { sessions: { ok: false, code: 'unavailable' }, now: later(60) }).snapshot;

    expect(failed.sources.find((s) => s.key === 'sessions')).toEqual({
      key: 'sessions',
      name: null,
      lastReadAt: NOW.toISOString(),
      lastAttemptAt: later(60).toISOString(),
      lastError: 'unavailable',
    });
  });
});

describe('leaving the snapshot by date', () => {
  it('drops a cancelled event 7 days after its start, and any event that started before the range', () => {
    const cancelled: SnapshotEvent[] = run(null, refreshRead([upstreamOnly('g6', MISTY, { startsAt: '2026-10-12T16:00:00.000Z' })])).snapshot.events.map(
      (e) => ({ ...e, cancelled: true }),
    );
    const before = { builtAt: NOW.toISOString(), events: cancelled, sources: [] };

    expect(run(before, localRead([]), { now: new Date('2026-10-19T15:00:00Z') }).snapshot.events).toHaveLength(1);
    expect(run(before, localRead([]), { now: new Date('2026-10-19T17:00:00Z') }).snapshot.events).toEqual([]);

    const old = run(null, refreshRead([upstreamOnly('g7', MISTY, { startsAt: '2026-09-19T16:00:00.000Z' })])).snapshot;
    expect(old.events).toEqual([]);
  });
});

describe('sources', () => {
  it('records a failed read with its error and keeps the last successful read time', () => {
    const first = run(null, refreshRead([upstreamOnly('g2', MISTY)])).snapshot;

    const failed = run(first, refreshRead([], { read: [], failed: [{ playerId: MISTY, code: 'needs_reconnect' }] }), { now: later(60) }).snapshot;

    expect(failed.sources.find((s) => s.key === `professor:${MISTY}`)).toEqual({
      key: `professor:${MISTY}`,
      name: 'Misty',
      lastReadAt: NOW.toISOString(),
      lastAttemptAt: later(60).toISOString(),
      lastError: 'needs_reconnect',
    });
  });

  it('leaves every source as it was on a local rebuild', () => {
    const first = run(null, refreshRead([upstreamOnly('g2', MISTY)])).snapshot;

    expect(run(first, localRead([]), { now: later(60) }).snapshot.sources).toEqual(first.sources);
  });
});
