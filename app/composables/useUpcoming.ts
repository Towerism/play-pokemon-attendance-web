import type { Upcoming } from '../../server/modules/tournaments/service';

/** Upcoming's `useFetch` key: the list and the dialogs that start tournament jobs refresh it together. */
export const UPCOMING_KEY = 'upcoming';

/** Planned and play-tools tournaments by date (ADR-0010 decision 10), from the server's 5-minute listing cache. */
export function useUpcoming(opts: { immediate?: boolean } = {}) {
  // Explicit type: inferring this route's response trips vue-tsc's recursion limit.
  return useFetch<Upcoming>('/api/tournaments/upcoming', { key: UPCOMING_KEY, immediate: opts.immediate ?? true });
}

/** Reads Upcoming again; `upstream` lists play-tools again (**Refresh**) instead of the server's cache. */
export async function refreshUpcoming(opts: { upstream?: boolean } = {}): Promise<Upcoming> {
  if (opts.upstream) {
    const fresh = await $fetch<Upcoming>('/api/tournaments/upcoming', { query: { refresh: '1' } });
    useNuxtData<Upcoming>(UPCOMING_KEY).data.value = fresh;
    return fresh;
  }
  await refreshNuxtData(UPCOMING_KEY);
  return useNuxtData<Upcoming>(UPCOMING_KEY).data.value!;
}
