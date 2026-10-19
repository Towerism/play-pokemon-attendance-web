import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDate } from '../../../shared/types/ids';
import type { UpstreamLeague } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { DateRange, PlaySession, PlaySessionStatus } from '../pokemon/ports/play-tools-gateway';
import { SubmissionError } from './errors';
import { type PlaySessionResolver, createPlaySessionResolver } from './resolve';

const TZ = 'America/Chicago';
const TUESDAY = '2026-10-13' as SessionDate;
const LEAGUE: UpstreamLeague = { id: 'group-1', name: 'Card Shop', displayId: 'L5012' };
/** The connection the caller reads as (ADR-0015 §4). */
const AS = 7;

const evening: PlaySession = {
  id: 'ps-evening',
  type: 'open_play',
  products: ['tcg'],
  status: 'pending',
  startsAt: new Date('2026-10-13T23:00:00Z'),
  endsAt: new Date('2026-10-14T02:00:00Z'),
  editableUntil: new Date('2026-10-20T23:00:00Z'),
};

let clock: Date;
let league: UpstreamLeague | null;
let readAs: number[];
let sessions: PlaySession[];
let listPlaySessions: ReturnType<typeof vi.fn<(g: string, r: DateRange, s?: readonly PlaySessionStatus[]) => Promise<PlaySession[]>>>;
let resolver: PlaySessionResolver;

beforeEach(() => {
  clock = new Date('2026-10-13T20:00:00Z');
  league = LEAGUE;
  readAs = [];
  sessions = [evening];
  listPlaySessions = vi.fn(async () => sessions);
  resolver = createPlaySessionResolver({
    connections: { league: () => league },
    gateway: (connectionId) => {
      readAs.push(connectionId);
      return { listPlaySessions };
    },
    timeZone: TZ,
    now: () => clock,
  });
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: Error) => e,
  );
}

describe('resolve (§4.4 date → play session)', () => {
  it("asks play-tools for the league's sessions starting that local day and labels them", async () => {
    const result = await resolver.resolve('default', TUESDAY, AS);

    expect(listPlaySessions).toHaveBeenCalledWith('group-1', { from: new Date('2026-10-13T05:00:00Z'), to: new Date('2026-10-14T05:00:00Z') });
    expect(readAs).toEqual([AS]);
    expect(result).toEqual({
      timeZone: TZ,
      candidates: [
        {
          id: 'ps-evening',
          label: 'Open play · TCG · Tue 6:00 PM',
          status: 'pending',
          startsAt: evening.startsAt,
          endsAt: evening.endsAt,
          editableUntil: evening.editableUntil,
          editable: true,
        },
      ],
    });
  });

  it('lists several sessions on one day by start time', async () => {
    const afternoon = { ...evening, id: 'ps-noon', startsAt: new Date('2026-10-13T17:00:00Z') };
    sessions = [evening, afternoon];
    expect((await resolver.resolve('default', TUESDAY, AS)).candidates.map((c) => c.id)).toEqual(['ps-noon', 'ps-evening']);
  });

  it('marks a session whose edit window has closed as not editable (design change 2)', async () => {
    clock = new Date('2026-10-21T00:00:00Z');
    expect((await resolver.resolve('default', TUESDAY, AS)).candidates[0]!.editable).toBe(false);
  });

  it('caches the answer for 5 minutes per date', async () => {
    await resolver.resolve('default', TUESDAY, AS);
    clock = new Date(clock.getTime() + 4 * 60_000);
    await resolver.resolve('default', TUESDAY, AS);
    expect(listPlaySessions).toHaveBeenCalledTimes(1);

    clock = new Date(clock.getTime() + 2 * 60_000);
    await resolver.resolve('default', TUESDAY, AS);
    expect(listPlaySessions).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure', async () => {
    listPlaySessions.mockRejectedValueOnce(new PokemonUpstreamError('unavailable', 'down'));
    await failure(resolver.resolve('default', TUESDAY, AS));
    expect((await resolver.resolve('default', TUESDAY, AS)).candidates).toHaveLength(1);
  });

  it('shares the cached answer between connections: play sessions belong to the league', async () => {
    await resolver.resolve('default', TUESDAY, AS);
    await resolver.resolve('default', TUESDAY, 8);
    expect(listPlaySessions).toHaveBeenCalledTimes(1);
  });

  it('is league_not_selected when no league is chosen in Settings', async () => {
    league = null;
    const err = await failure(resolver.resolve('default', TUESDAY, AS));
    expect(err).toBeInstanceOf(SubmissionError);
    expect((err as SubmissionError).code).toBe('league_not_selected');
    expect(listPlaySessions).not.toHaveBeenCalled();
  });
});

describe('find', () => {
  it("returns the date's candidate with that id", async () => {
    expect((await resolver.find('default', TUESDAY, 'ps-evening', AS)).id).toBe('ps-evening');
  });

  it("is unknown_play_session for an id that is not that date's session", async () => {
    const err = await failure(resolver.find('default', TUESDAY, 'some-other-guid', AS));
    expect((err as SubmissionError).code).toBe('unknown_play_session');
  });
});
