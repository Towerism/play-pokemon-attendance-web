import type { LeasesResponse } from '~/utils/leases';

/**
 * The live tournament leases the viewer granted or holds (the owner: all), and who they could lend to (ADR-0015 §5),
 * under one key. While a notice is still sending it reads again every 5 seconds, for at most 2 minutes.
 */
export function useLeaseList() {
  const result = useFetch<LeasesResponse>('/api/tournament-leases', { key: 'tournament-leases' });
  let firstReadAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    if (import.meta.client && shouldPollLeases(result.data.value?.leases ?? [], firstReadAt, Date.now())) {
      timer = setTimeout(() => void result.refresh(), 5_000);
    }
  };
  watch(result.data, (now, before) => {
    // A new sending notice starts a fresh 2 minutes.
    if ((now?.leases ?? []).some((l) => l.notice === 'sending' && !before?.leases.some((b) => b.id === l.id && b.notice === 'sending'))) firstReadAt = Date.now();
    schedule();
  });
  onScopeDispose(() => clearTimeout(timer));
  return result;
}

export const refreshLeases = () => refreshNuxtData('tournament-leases');
