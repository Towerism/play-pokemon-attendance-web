export type HitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface FixedWindowLimiter {
  /** Counts the hit when allowed; rejected hits aren't counted. */
  hit(key: string): HitResult;
  /** Keys currently tracked. */
  size(): number;
}

/**
 * At most `max` hits per key in a window that starts at the key's first
 * counted hit. In memory: counts reset on restart. The map is kept in
 * window-start order, so when it's full the oldest window is evicted first.
 */
export function createFixedWindowLimiter(opts: { max: number; windowMs: number; capacity?: number; now?: () => number }): FixedWindowLimiter {
  const { max, windowMs, capacity = 10_000, now = Date.now } = opts;
  const windows = new Map<string, { start: number; count: number }>();

  return {
    hit(key) {
      const t = now();
      const current = windows.get(key);
      if (current && t - current.start < windowMs) {
        if (current.count >= max) {
          return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.start + windowMs - t) / 1000)) };
        }
        current.count++;
        return { allowed: true };
      }
      // New or expired window: re-insert so the map stays in start order.
      windows.delete(key);
      if (windows.size >= capacity) windows.delete(windows.keys().next().value!);
      windows.set(key, { start: t, count: 1 });
      return { allowed: true };
    },
    size: () => windows.size,
  };
}
