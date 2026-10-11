import { describe, expect, it } from 'vitest';
import { createFixedWindowLimiter } from './rate-limit';

function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

describe('createFixedWindowLimiter', () => {
  it('allows max hits per key, then rejects with the seconds left', () => {
    const c = clock();
    const limiter = createFixedWindowLimiter({ max: 2, windowMs: 1000, now: c.now });

    expect(limiter.hit('a')).toEqual({ allowed: true });
    expect(limiter.hit('a')).toEqual({ allowed: true });
    c.set(999);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('resets once the window since the first counted hit has elapsed', () => {
    const c = clock();
    const limiter = createFixedWindowLimiter({ max: 2, windowMs: 1000, now: c.now });
    limiter.hit('a');
    limiter.hit('a');

    c.set(1000);
    expect(limiter.hit('a')).toEqual({ allowed: true });
    expect(limiter.hit('a')).toEqual({ allowed: true });
    expect(limiter.hit('a')).toMatchObject({ allowed: false });
  });

  it('rounds the wait up to whole seconds', () => {
    const c = clock();
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 900_000, now: c.now });
    limiter.hit('a');

    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 900 });
    c.set(1);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 900 });
    c.set(899_001);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('keeps a separate count per key', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1000, now: clock().now });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('does not count rejected hits or extend the window with them', () => {
    const c = clock();
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1000, now: c.now });
    limiter.hit('a');
    for (let t = 100; t < 1000; t += 100) {
      c.set(t);
      expect(limiter.hit('a').allowed).toBe(false);
    }
    c.set(1000);
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('lets exactly max through a synchronous burst', () => {
    const limiter = createFixedWindowLimiter({ max: 10, windowMs: 1000, now: clock().now });
    const allowed = Array.from({ length: 15 }, () => limiter.hit('a')).filter((r) => r.allowed);
    expect(allowed).toHaveLength(10);
  });

  it('bounds memory by evicting the entry whose window started first', () => {
    const c = clock();
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 10_000, capacity: 3, now: c.now });
    limiter.hit('a');
    c.set(1);
    limiter.hit('b');
    c.set(2);
    limiter.hit('c');
    c.set(3);
    limiter.hit('d');

    expect(limiter.size()).toBe(3);
    // 'a' was evicted, so it starts fresh; 'b' is still counted.
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('c').allowed).toBe(false);
  });

  it('defaults to 10,000 tracked keys', () => {
    const limiter = createFixedWindowLimiter({ max: 1, windowMs: 1000, now: clock().now });
    for (let i = 0; i < 10_001; i++) limiter.hit(`k${i}`);
    expect(limiter.size()).toBe(10_000);
  });
});
