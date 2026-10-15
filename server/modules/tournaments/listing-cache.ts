import type { Tournament } from '../pokemon/ports/play-tools-gateway';
import type { TournamentsGateway } from './service';

/** How long a professor's tournament listing is reused (ADR-0010 decision 12, #102). */
export const LISTING_TTL_MS = 5 * 60_000;

/**
 * Each connection's tournament listing for a range, kept briefly and shared by required-events coverage and Upcoming
 * (ADR-0010 Update #95 item 8, #98), so loading the Tournaments page doesn't list every professor live each time.
 */
export interface ListingCache {
  /** One connection's tournaments in the range: reused for `LISTING_TTL_MS`, shared while in flight, failures not kept. */
  read(connectionId: number, range: { from: Date; to: Date }, opts: { refresh: boolean }): Promise<readonly Tournament[]>;
  /** A tournament job ended: drop everything, and don't keep reads already in flight. */
  clear(): void;
}

export function createListingCache(deps: {
  now: () => Date;
  gateway: (connectionId: number) => Pick<TournamentsGateway, 'listTournaments'>;
}): ListingCache {
  /** connection|from|to → a listing read within the TTL. */
  const kept = new Map<string, { at: number; tournaments: readonly Tournament[] }>();
  /** The same key → the read in flight, shared by concurrent requests. */
  const inFlight = new Map<string, Promise<readonly Tournament[]>>();
  /** Bumped by `clear`, so a read already in flight doesn't put a stale listing back. */
  let generation = 0;

  return {
    read(connectionId, range, opts) {
      const key = `${connectionId}|${range.from.toISOString()}|${range.to.toISOString()}`;
      const at = deps.now().getTime();
      // Drop what has expired, so ranges nobody asks for any more don't pile up.
      for (const [k, v] of kept) if (at - v.at >= LISTING_TTL_MS) kept.delete(k);
      const hit = kept.get(key);
      if (!opts.refresh && hit) return Promise.resolve(hit.tournaments);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const startedIn = generation;
      const read = deps
        .gateway(connectionId)
        .listTournaments(range)
        .then((tournaments) => {
          if (startedIn === generation) kept.set(key, { at, tournaments });
          return tournaments;
        })
        .finally(() => {
          if (inFlight.get(key) === read) inFlight.delete(key);
        });
      inFlight.set(key, read);
      return read;
    },

    clear() {
      generation++;
      kept.clear();
      inFlight.clear();
    },
  };
}
