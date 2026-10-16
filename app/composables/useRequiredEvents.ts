import type { RequiredEventsCoverage } from '../../server/modules/tournaments/required-events';

/** The `useFetch` key the nav badge and the Required events grid share, so one read updates both (#98). */
export const REQUIRED_EVENTS_KEY = 'required-events';

/** Required-events coverage (ADR-0010 decision 12): the grid on Tournaments and the nav badge read it together. */
export function useRequiredEvents(opts: { immediate?: boolean } = {}) {
  // Explicit type: inferring this route's response trips vue-tsc's recursion limit. `defer`: a second user of the key
  // joins the read already in flight instead of cancelling it and sending another (#191).
  return useFetch<RequiredEventsCoverage>('/api/tournaments/requirements', { key: REQUIRED_EVENTS_KEY, immediate: opts.immediate ?? true, dedupe: 'defer' });
}

/**
 * Reads coverage again for everyone using the key. `upstream` lists play-tools again first (**Refresh**); otherwise the
 * server's 5-minute listing cache answers, which a finished tournament job has already dropped. Always a new read:
 * the key defers to a read in flight, which may have started before the change being refreshed for. Only **Refresh**
 * (`upstream`) reports a failed read; after a change, the coverage already shown stays, so the change still reads as done.
 */
export async function refreshRequiredEvents(opts: { upstream?: boolean } = {}): Promise<void> {
  const read = $fetch<RequiredEventsCoverage>('/api/tournaments/requirements', { query: opts.upstream ? { refresh: '1' } : {} });
  const fresh = opts.upstream ? await read : await read.catch(() => null);
  if (fresh) useNuxtData<RequiredEventsCoverage>(REQUIRED_EVENTS_KEY).data.value = fresh;
}
