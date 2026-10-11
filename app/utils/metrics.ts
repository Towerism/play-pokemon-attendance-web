import type { PlayerMetrics } from '../../server/modules/metrics/metrics';

/** e.g. "67%"; "—" when the league held no session to rate against. */
export function ratePercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

const sessions = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

/** Last seen, in league sessions (metrics count sessions, not days). */
export function lastSeenLabel(metrics: Pick<PlayerMetrics, 'sessionsSinceLastSeen'> | null): string {
  if (!metrics) return 'Never';
  return metrics.sessionsSinceLastSeen === 0 ? 'Latest session' : `${sessions(metrics.sessionsSinceLastSeen)} ago`;
}

/** Why a regular is stale: being recorded upstream doesn't count as present (ADR-0005). */
export function absenceLabel(metrics: Pick<PlayerMetrics, 'sessionsSinceLastPresent'> | null): string {
  const n = metrics?.sessionsSinceLastPresent ?? null;
  return n === null ? 'No tdf or manual sighting yet' : `Not present for ${sessions(n)}`;
}
