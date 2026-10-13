import type { Format, Series, Venue } from '../pokemon/ports/play-tools-gateway';
import type { TournamentsGateway } from './service';

/** How long a form's choices are reused (ADR-0010 decision 6: at most 10 minutes, as the organizer). */
export const LIVE_READ_TTL_MS = 10 * 60_000;

/** play-tools' series, formats and venues as one professor, each kept for 10 minutes. A failed read isn't kept. */
export interface LiveReads {
  series(connectionId: number, groupId: string): Promise<readonly Series[]>;
  formats(connectionId: number, country: string): Promise<readonly Format[]>;
  venues(connectionId: number, groupId: string, country: string): Promise<readonly Venue[]>;
}

export function createLiveReads(deps: { gateway: (connectionId: number) => TournamentsGateway; now: () => Date }): LiveReads {
  const cache = new Map<string, { at: number; value: unknown }>();

  async function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    const at = deps.now().getTime();
    if (hit && at - hit.at < LIVE_READ_TTL_MS) return hit.value as T;
    const value = await read();
    cache.set(key, { at, value });
    return value;
  }

  return {
    series: (c, groupId) => cached(`series|${c}|${groupId}`, () => deps.gateway(c).listSeries(groupId)),
    formats: (c, country) => cached(`formats|${c}|${country}`, () => deps.gateway(c).listFormats(country)),
    venues: (c, groupId, country) => cached(`venues|${c}|${groupId}|${country}`, () => deps.gateway(c).listVenues(groupId, country)),
  };
}
