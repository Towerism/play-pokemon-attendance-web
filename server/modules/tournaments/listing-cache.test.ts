import { beforeEach, describe, expect, it } from 'vitest';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { Tournament } from '../pokemon/ports/play-tools-gateway';
import { LISTING_TTL_MS, type ListingCache, createListingCache } from './listing-cache';

// The one listing cache coverage and Upcoming share (ADR-0010 decision 12, Update #95 item 8; #98). The clock is
// moved by hand and held listings wait on a gate the test opens, never on sleeps.

const RANGE = { from: new Date('2026-10-12T05:00:00Z'), to: new Date('2027-04-14T05:00:00Z') };
const T0 = new Date('2026-10-14T17:00:00Z');
const tournament = (id: string) => ({ id }) as Tournament;

let now: Date;
let calls: number[];
let answers: Map<number, () => Promise<readonly Tournament[]>>;
let cache: ListingCache;

beforeEach(() => {
  now = T0;
  calls = [];
  answers = new Map();
  cache = createListingCache({
    now: () => now,
    gateway: (id) => ({
      listTournaments: () => {
        calls.push(id);
        return (answers.get(id)?.() ?? Promise.resolve([tournament(`t${id}`)])) as Promise<Tournament[]>;
      },
    }),
  });
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

describe('the listing cache', () => {
  it('keeps a listing for 5 minutes per connection and range, then reads again', async () => {
    expect(await cache.read(1, RANGE, { refresh: false })).toEqual([tournament('t1')]);
    now = new Date(T0.getTime() + LISTING_TTL_MS - 1);
    await cache.read(1, RANGE, { refresh: false });
    expect(calls).toEqual([1]);
    await cache.read(2, RANGE, { refresh: false });
    await cache.read(1, { ...RANGE, to: new Date('2027-01-01T06:00:00Z') }, { refresh: false });
    expect(calls).toEqual([1, 2, 1]);
    now = new Date(T0.getTime() + LISTING_TTL_MS);
    await cache.read(1, RANGE, { refresh: false });
    expect(calls).toEqual([1, 2, 1, 1]);
  });

  it('reads again on refresh, and keeps what the refresh read', async () => {
    await cache.read(1, RANGE, { refresh: false });
    await cache.read(1, RANGE, { refresh: true });
    await cache.read(1, RANGE, { refresh: false });
    expect(calls).toEqual([1, 1]);
  });

  it('never keeps a failure', async () => {
    answers.set(1, () => Promise.reject(new PokemonUpstreamError('unavailable', 'down')));
    await expect(cache.read(1, RANGE, { refresh: false })).rejects.toThrow('down');
    answers.delete(1);
    expect(await cache.read(1, RANGE, { refresh: false })).toEqual([tournament('t1')]);
    expect(calls).toEqual([1, 1]);
  });

  it('shares one read between two callers at once', async () => {
    const held = gate();
    answers.set(1, () => held.promise.then(() => [tournament('held')]));
    const a = cache.read(1, RANGE, { refresh: false });
    const b = cache.read(1, RANGE, { refresh: false });
    held.open();
    expect(await a).toEqual(await b);
    expect(calls).toEqual([1]);
  });

  it('drops everything on clear, and never keeps a read that was in flight then', async () => {
    await cache.read(2, RANGE, { refresh: false });
    const held = gate();
    answers.set(1, () => held.promise.then(() => [tournament('stale')]));
    const inFlight = cache.read(1, RANGE, { refresh: false });
    cache.clear();
    held.open();
    expect(await inFlight).toEqual([tournament('stale')]);
    answers.delete(1);
    expect(await cache.read(1, RANGE, { refresh: false })).toEqual([tournament('t1')]);
    await cache.read(2, RANGE, { refresh: false });
    expect(calls).toEqual([2, 1, 1, 2]);
  });
});
