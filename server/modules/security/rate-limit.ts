// Shim (kit ADR-0007, A1): the limiter now comes from @towerism/selfhost-kit, which takes a `clock`.
import { type FixedWindowLimiter, createFixedWindowLimiter as kitLimiter } from '@towerism/selfhost-kit';

export type { FixedWindowLimiter, HitResult } from '@towerism/selfhost-kit';

export function createFixedWindowLimiter(opts: { max: number; windowMs: number; capacity?: number; now?: () => number }): FixedWindowLimiter {
  const { now, ...rest } = opts;
  return kitLimiter({ ...rest, ...(now ? { clock: { now } } : {}) });
}
