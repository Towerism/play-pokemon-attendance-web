import { beforeEach, describe, expect, it } from 'vitest';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { DateRange, PlaySession, PlaySessionStatus } from '../pokemon/ports/play-tools-gateway';
import { createPlaySessionLister } from './play-sessions';

const RANGE: DateRange = { from: new Date('2026-09-20T05:00:00Z'), to: new Date('2027-04-20T05:00:00Z') };

function session(id: string, status: PlaySessionStatus, startsAt: string): PlaySession {
  return { id, type: 'open_play', products: ['tcg'], startsAt: new Date(startsAt), endsAt: null, editableUntil: null, status };
}

let sessions: PlaySession[];
let calls: string[];
let failing: PlaySessionStatus | null;
let league: { id: string; name: string; displayId: string | null } | null;
let reader: number | Error;

const lister = () =>
  createPlaySessionLister({
    connections: {
      league: () => league,
      readingConnection: () => {
        if (reader instanceof Error) throw reader;
        return reader;
      },
    },
    // Like the real adapter, one call lists the given statuses; this test asks for one status at a time.
    gateway: (connectionId) => ({
      async listPlaySessions(groupId, range, statuses) {
        calls.push(`${connectionId} ${groupId} ${statuses?.join(',')} ${range.from.toISOString()}..${range.to.toISOString()}`);
        if (statuses?.includes(failing!)) throw new PokemonUpstreamError('unavailable', 'play-tools is down');
        return sessions.filter((s) => statuses?.includes(s.status));
      },
    }),
  });

beforeEach(() => {
  sessions = [];
  calls = [];
  failing = null;
  league = { id: 'group-1', name: 'Cerulean League', displayId: 'L1' };
  reader = 7;
});

describe('listPlaySessionsInRange', () => {
  it('lists active, pending and complete sessions with one call each, as the reading connection, and merges them by start', async () => {
    sessions = [
      session('b', 'pending', '2026-10-29T23:00:00Z'),
      session('a', 'active', '2026-10-22T23:00:00Z'),
      session('c', 'pending', '2026-11-05T23:00:00Z'),
      session('old', 'complete', '2026-10-01T23:00:00Z'),
    ];

    const listed = await lister().listPlaySessionsInRange('default', RANGE);

    expect(listed.map((s) => s.id)).toEqual(['old', 'a', 'b', 'c']);
    expect(calls).toEqual([
      `7 group-1 active ${RANGE.from.toISOString()}..${RANGE.to.toISOString()}`,
      `7 group-1 pending ${RANGE.from.toISOString()}..${RANGE.to.toISOString()}`,
      `7 group-1 complete ${RANGE.from.toISOString()}..${RANGE.to.toISOString()}`,
    ]);
  });

  it('lists a session once when play-tools reports it under more than one status', async () => {
    sessions = [session('a', 'active', '2026-10-22T23:00:00Z'), { ...session('a', 'pending', '2026-10-22T23:00:00Z') }];

    expect((await lister().listPlaySessionsInRange('default', RANGE)).map((s) => s.id)).toEqual(['a']);
  });

  it('fails when any of the three calls fails, so the caller counts no status as read', async () => {
    sessions = [session('a', 'active', '2026-10-22T23:00:00Z')];
    failing = 'pending';

    await expect(lister().listPlaySessionsInRange('default', RANGE)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('fails before any call when no league is chosen or no connection can read', async () => {
    league = null;
    await expect(lister().listPlaySessionsInRange('default', RANGE)).rejects.toMatchObject({ code: 'league_not_selected' });

    league = { id: 'group-1', name: 'Cerulean League', displayId: 'L1' };
    reader = new PokemonUpstreamError('not_connected', 'No connection');
    await expect(lister().listPlaySessionsInRange('default', RANGE)).rejects.toMatchObject({ code: 'not_connected' });
    expect(calls).toEqual([]);
  });
});
