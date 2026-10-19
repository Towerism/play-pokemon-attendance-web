import type { Thresholds } from '#shared/schemas/settings';
import type { WaitingReason } from '~/utils/pokemon-connections';

/** Who is signed in and whether they may see the league (ADR-0015 §3), as `GET /api/settings` answers it. */
export interface AccessJson {
  username: string;
  role: 'owner' | 'professor';
  member: boolean;
  waiting: WaitingReason;
}

/** `GET /api/settings`: a professor not yet in the league gets only `access`. */
export interface SettingsJson {
  access: AccessJson;
  thresholds?: Thresholds;
  league?: { timeZone: string; today: string };
}

/** The settings read, shared by the layout, Settings and Tournaments under one key. */
export function useSettings(opts: { immediate?: boolean } = {}) {
  // Explicit type: inferring this route's response trips vue-tsc's recursion limit.
  return useFetch<SettingsJson>('/api/settings', { key: 'settings', dedupe: 'defer', immediate: opts.immediate ?? true });
}

export const refreshSettings = () => refreshNuxtData('settings');
