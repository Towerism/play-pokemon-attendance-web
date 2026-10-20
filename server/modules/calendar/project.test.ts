import { describe, expect, it } from 'vitest';
import type { IcalEvent } from './ical';
import { type FeedContext, projectFeed, staleSources } from './project';
import type { Snapshot, SnapshotEvent, SnapshotSource } from './snapshot';
import { BROCK, MISTY, OAK } from './test-helpers';

// What one feed shows from the league's snapshot (ADR-0016 §2, §3 and §5), filtered when it is fetched.

const NOW = new Date('2026-10-20T15:00:00Z');
const BUILT = '2026-10-20T14:00:00.000Z';
const CTX: FeedContext = {
  now: NOW,
  leagueName: 'Cerulean League',
  timeZone: 'America/Chicago',
  range: { from: new Date('2026-09-20T05:00:00Z'), to: new Date('2027-04-21T05:00:00Z') },
  goneSources: new Set(),
};
const DAY = 86_400_000;

function ev(uid: string, overrides: Partial<SnapshotEvent> = {}): SnapshotEvent {
  return {
    uid,
    kind: 'tournament',
    plannedId: null,
    tournamentId: uid,
    sessionId: null,
    source: `professor:${OAK}`,
    sourceConfirmed: true,
    created: true,
    organizerPlayerId: OAK,
    name: `Cup ${uid}`,
    startsAt: '2026-11-07T19:00:00.000Z',
    endsAt: '2026-11-07T23:00:00.000Z',
    location: null,
    details: ['TCG'],
    url: null,
    tentative: false,
    cancelled: false,
    applicationState: 'sanctioned',
    plannedState: null,
    contentHash: 'h',
    lastModified: '2026-10-19T08:00:00.000Z',
    ...overrides,
  };
}

const source = (key: string, overrides: Partial<SnapshotSource> = {}): SnapshotSource => ({
  key,
  name: null,
  lastReadAt: BUILT,
  lastAttemptAt: BUILT,
  lastError: null,
  ...overrides,
});

function snapshot(events: SnapshotEvent[], sources: SnapshotSource[] = []): Snapshot {
  return { builtAt: BUILT, events, sources };
}

const T1 = ev('t1');
const T2 = ev('t2', { source: `professor:${MISTY}`, organizerPlayerId: MISTY });
const P1 = ev('p1', { tournamentId: null, plannedId: 1, created: false, tentative: true, organizerPlayerId: MISTY, sourceConfirmed: false, source: `professor:${MISTY}` });
const S1 = ev('s1', { kind: 'session', tournamentId: null, sessionId: 's1', source: 'sessions', organizerPlayerId: null, name: 'Open play · TCG, VG', details: [] });
const ALL = snapshot([T1, T2, P1, S1]);

const byUid = (events: readonly IcalEvent[], uid: string) => events.find((e) => e.uid === uid);
const user = (playerIds: string[], extra: Partial<Extract<Parameters<typeof projectFeed>[1], { kind: 'user' }>> = {}) =>
  ({ kind: 'user' as const, playerIds: new Set(playerIds), assignments: [], leases: [], ...extra });

describe('the public feed', () => {
  it("holds the league's created tournaments and play sessions, named after the league", () => {
    const cal = projectFeed(ALL, { kind: 'public' }, CTX);

    expect(cal).toMatchObject({ name: 'Cerulean League', timeZone: 'America/Chicago', stamp: new Date(BUILT) });
    expect(cal.events.map((e) => e.uid).sort()).toEqual(['s1', 't1', 't2']);
    expect(byUid(cal.events, 't1')).toEqual({
      uid: 't1',
      start: new Date('2026-11-07T19:00:00.000Z'),
      end: new Date('2026-11-07T23:00:00.000Z'),
      summary: 'Cup t1',
      description: 'TCG',
      location: null,
      url: null,
      status: 'CONFIRMED',
      lastModified: new Date('2026-10-19T08:00:00.000Z'),
    });
  });

  it('shows a cancelled event as cancelled, and a tentative one as tentative', () => {
    const cal = projectFeed(snapshot([ev('c', { cancelled: true }), ev('t', { tentative: true })]), { kind: 'public' }, CTX);

    expect(byUid(cal.events, 'c')).toMatchObject({ summary: 'Cancelled: Cup c', status: 'CANCELLED' });
    expect(byUid(cal.events, 't')).toMatchObject({ summary: 'Cup t', status: 'TENTATIVE' });
  });

  it('leaves out an event that started before the range, or after it ends, and a cancelled one 7 days after its start', () => {
    const cal = projectFeed(
      snapshot([
        ev('old', { startsAt: new Date(CTX.range.from.getTime() - 1).toISOString() }),
        ev('edge', { startsAt: CTX.range.from.toISOString() }),
        ev('far', { startsAt: CTX.range.to.toISOString() }),
        ev('cancelled-long-ago', { cancelled: true, startsAt: new Date(NOW.getTime() - 7 * DAY).toISOString() }),
        ev('cancelled-recently', { cancelled: true, startsAt: new Date(NOW.getTime() - 7 * DAY + 60_000).toISOString() }),
      ]),
      { kind: 'public' },
      CTX,
    );

    expect(cal.events.map((e) => e.uid).sort()).toEqual(['cancelled-recently', 'edge']);
  });
});

describe('unconfirmed events', () => {
  it("marks the events of a professor who is gone at once, with the date of their last read", () => {
    const cal = projectFeed(
      snapshot([T1, T2], [source(`professor:${MISTY}`, { lastReadAt: '2026-10-01T18:00:00.000Z' })]),
      { kind: 'public' },
      { ...CTX, goneSources: new Set([`professor:${MISTY}`]) },
    );

    expect(byUid(cal.events, 't2')!.summary).toBe('Cup t2 (not confirmed since 2026-10-01)');
    expect(byUid(cal.events, 't1')!.summary).toBe('Cup t1');
  });

  it('marks the events of a source whose reads have failed for more than 14 days, and not before', () => {
    const failing = (lastReadAt: string) => snapshot([T2], [source(`professor:${MISTY}`, { lastReadAt, lastError: 'needs_reconnect' })]);

    expect(projectFeed(failing(new Date(NOW.getTime() - 14 * DAY + 60_000).toISOString()), { kind: 'public' }, CTX).events[0]!.summary).toBe('Cup t2');
    expect(projectFeed(failing('2026-10-05T12:00:00.000Z'), { kind: 'public' }, CTX).events[0]!.summary).toBe(
      'Cup t2 (not confirmed since 2026-10-05)',
    );
  });

  it('leaves out an unconfirmed event 7 days after its start', () => {
    const past = ev('t2', { source: `professor:${MISTY}`, startsAt: new Date(NOW.getTime() - 7 * DAY).toISOString() });

    const cal = projectFeed(snapshot([past], [source(`professor:${MISTY}`)]), { kind: 'public' }, { ...CTX, goneSources: new Set([`professor:${MISTY}`]) });

    expect(cal.events).toEqual([]);
  });

  it('puts both marks on a cancelled event of a gone source', () => {
    const cal = projectFeed(snapshot([ev('t2', { source: `professor:${MISTY}`, cancelled: true })], [source(`professor:${MISTY}`)]), { kind: 'public' }, {
      ...CTX,
      goneSources: new Set([`professor:${MISTY}`]),
    });

    expect(cal.events[0]!.summary).toBe('Cancelled: Cup t2 (not confirmed since 2026-10-20)');
  });
});

describe('a user feed', () => {
  it("holds the tournaments the user organizes, planned ones as tentative, and no sessions, named as theirs", () => {
    const cal = projectFeed(ALL, user([MISTY]), CTX);

    expect(cal.name).toBe('Cerulean League: my tournaments');
    expect(cal.events.map((e) => e.uid).sort()).toEqual(['p1', 't2']);
    expect(byUid(cal.events, 't2')).toMatchObject({ description: 'You organize\nTCG', status: 'CONFIRMED' });
    expect(byUid(cal.events, 'p1')).toMatchObject({ description: 'You organize\nTCG', status: 'TENTATIVE' });
  });

  it('holds the tournaments the user is staff on, with each role, and those lent to them, with the end date', () => {
    const cal = projectFeed(
      ALL,
      user([BROCK], {
        assignments: [
          { tournamentId: 't1', playerId: BROCK, role: 'judge', roleLabel: 'Judge', createdAt: new Date('2026-10-18T00:00:00Z') },
          { tournamentId: 't1', playerId: BROCK, role: 'scorekeeper', roleLabel: 'Scorekeeper', createdAt: new Date('2026-10-20T10:00:00Z') },
        ],
        leases: [{ tournamentId: 't2', endsAt: new Date('2026-11-15T06:00:00Z'), grantedAt: new Date('2026-10-10T00:00:00Z') }],
      }),
      CTX,
    );

    expect(cal.events.map((e) => e.uid).sort()).toEqual(['t1', 't2']);
    expect(byUid(cal.events, 't1')).toMatchObject({
      description: 'Staff: Judge\nStaff: Scorekeeper\nTCG',
      lastModified: new Date('2026-10-20T10:00:00Z'),
    });
    expect(byUid(cal.events, 't2')).toMatchObject({ description: 'Lent to you until 2026-11-14\nTCG', lastModified: new Date('2026-10-19T08:00:00.000Z') });
  });

  it('puts every part the user has, organizer first', () => {
    const cal = projectFeed(
      snapshot([T1]),
      user([OAK, BROCK], {
        assignments: [{ tournamentId: 't1', playerId: BROCK, role: 'judge', roleLabel: 'Judge', createdAt: new Date('2026-10-01T00:00:00Z') }],
        leases: [{ tournamentId: 't1', endsAt: new Date('2026-11-15T06:00:00Z'), grantedAt: new Date('2026-10-01T00:00:00Z') }],
      }),
      CTX,
    );

    expect(cal.events[0]!.description).toBe('You organize\nStaff: Judge\nLent to you until 2026-11-14\nTCG');
  });

  it('never shows a planned tournament for staff or a lease, only to its organizer', () => {
    const cal = projectFeed(
      snapshot([P1]),
      user([BROCK], { assignments: [{ tournamentId: 'p1', playerId: BROCK, role: 'judge', roleLabel: 'Judge', createdAt: NOW }] }),
      CTX,
    );

    expect(cal.events).toEqual([]);
  });

  it('counts the professor whose listing holds a tournament as its organizer, not a template organizer it no longer has', () => {
    const moved = ev('t9', { plannedId: 9, organizerPlayerId: BROCK, source: `professor:${OAK}`, sourceConfirmed: true });

    expect(projectFeed(snapshot([moved]), user([OAK]), CTX).events.map((e) => e.uid)).toEqual(['t9']);
    expect(projectFeed(snapshot([moved]), user([BROCK]), CTX).events).toEqual([]);
  });

  it('holds nothing for a user with no player ID left', () => {
    expect(projectFeed(ALL, user([]), CTX).events).toEqual([]);
  });
});

describe('staleSources', () => {
  it('lists gone sources, and failing ones not read for over 14 days, but not one nobody refreshed lately', () => {
    const snap = snapshot(
      [],
      [
        source(`professor:${OAK}`, { name: 'Prof Oak', lastReadAt: '2026-09-01T00:00:00.000Z', lastError: null }),
        source(`professor:${MISTY}`, { name: 'Misty', lastReadAt: '2026-10-19T00:00:00.000Z' }),
        source(`professor:${BROCK}`, { name: 'Brock', lastReadAt: '2026-10-01T00:00:00.000Z', lastError: 'needs_reconnect' }),
        source('sessions', { lastReadAt: '2026-10-19T00:00:00.000Z', lastError: 'unavailable' }),
      ],
    );

    expect(staleSources(snap, { now: NOW, goneSources: new Set([`professor:${MISTY}`]) })).toEqual([
      { key: `professor:${BROCK}`, name: 'Brock', lastReadAt: '2026-10-01T00:00:00.000Z' },
      { key: `professor:${MISTY}`, name: 'Misty', lastReadAt: '2026-10-19T00:00:00.000Z' },
    ]);
  });
});
