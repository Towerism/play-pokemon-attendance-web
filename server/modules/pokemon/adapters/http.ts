import { PokemonUpstreamError } from '../ports/errors';

/** Shared by both adapters: transport and throttling failures as port errors. */

/** `fetch`, with a network failure turned into a retryable `unavailable`. */
export async function fetchUpstream(url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new PokemonUpstreamError('unavailable', `${what}: could not reach Pokémon (${(err as Error).message}).`, { cause: err });
  }
}

/** 429 and 5xx as retryable errors; `undefined` for any other status. */
export function throttleOrServerError(res: Response, what: string): PokemonUpstreamError | undefined {
  if (res.status === 429) {
    return new PokemonUpstreamError('rate_limited', `${what}: Pokémon is throttling requests.`, {
      status: 429,
      retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
    });
  }
  if (res.status >= 500) {
    return new PokemonUpstreamError('unavailable', `${what}: Pokémon answered ${res.status}.`, { status: res.status });
  }
  return undefined;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export async function jsonOrUndefined(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
