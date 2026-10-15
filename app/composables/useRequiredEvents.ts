import type { RequiredEventsCoverage } from '../../server/modules/tournaments/required-events';

/** The `useFetch` key the nav badge and the Required events grid share, so one read updates both (#98). */
export const REQUIRED_EVENTS_KEY = 'required-events';

/** Required-events coverage (ADR-0010 decision 12): the grid on Tournaments and the nav badge read it together. */
export function useRequiredEvents(opts: { immediate?: boolean } = {}) {
  // Explicit type: inferring this route's response trips vue-tsc's recursion limit.
  return useFetch<RequiredEventsCoverage>('/api/tournaments/requirements', { key: REQUIRED_EVENTS_KEY, immediate: opts.immediate ?? true });
}

/**
 * Reads coverage again for everyone using the key. `upstream` lists play-tools again first (**Refresh**); otherwise the
 * server's 5-minute listing cache answers, which a finished tournament job has already dropped.
 */
export async function refreshRequiredEvents(opts: { upstream?: boolean } = {}): Promise<void> {
  if (opts.upstream) {
    const fresh = await $fetch<RequiredEventsCoverage>('/api/tournaments/requirements', { query: { refresh: '1' } });
    useNuxtData<RequiredEventsCoverage>(REQUIRED_EVENTS_KEY).data.value = fresh;
    return;
  }
  await refreshNuxtData(REQUIRED_EVENTS_KEY);
}
