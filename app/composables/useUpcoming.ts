import type { Upcoming } from '../../server/modules/tournaments/service';

/** Upcoming's `useFetch` key: the list and the dialogs that start tournament jobs refresh it together. */
export const UPCOMING_KEY = 'upcoming';

/** Planned and play-tools tournaments by date (ADR-0010 decision 10), from the server's 5-minute listing cache. */
export function useUpcoming(opts: { immediate?: boolean } = {}) {
  // Explicit type: inferring this route's response trips vue-tsc's recursion limit. `defer`: the Tournaments page
  // starts this read and Upcoming joins it (#191).
  return useFetch<Upcoming>('/api/tournaments/upcoming', { key: UPCOMING_KEY, immediate: opts.immediate ?? true, dedupe: 'defer' });
}

/**
 * Reads Upcoming again; `upstream` lists play-tools again (**Refresh**) instead of the server's cache. With `range` (one
 * date on This week, #99) it reads just that range and leaves the Tournaments page's `upcoming` key alone.
 */
export async function refreshUpcoming(opts: { upstream?: boolean; range?: { from: string; to: string } } = {}): Promise<Upcoming> {
  if (opts.range) return $fetch<Upcoming>('/api/tournaments/upcoming', { query: upcomingQuery(opts) });
  // Always a new read: the key defers to a read in flight, which may have started before the change being refreshed for.
  // Only **Refresh** (`upstream`) reports a failed read; after a change, the list already shown stays.
  const shown = useNuxtData<Upcoming>(UPCOMING_KEY).data;
  try {
    shown.value = await $fetch<Upcoming>('/api/tournaments/upcoming', { query: upcomingQuery(opts) });
  } catch (err) {
    if (opts.upstream || !shown.value) throw err;
  }
  return shown.value!;
}
