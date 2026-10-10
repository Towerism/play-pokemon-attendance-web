import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { withFileLock } from './lock';

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'lock-test-')), 'refresh.lock');

describe('withFileLock', () => {
  it('serialises concurrent holders and releases the lock afterwards', async () => {
    const path = lockPath();
    const events: string[] = [];
    const task = (name: string) =>
      withFileLock(path, async () => {
        events.push(`${name}:start`);
        await sleep(30);
        events.push(`${name}:end`);
      }, { pollMs: 5 });

    await Promise.all([task('a'), task('b')]);

    expect(events).toHaveLength(4);
    expect(events[1]).toBe(events[0]!.replace('start', 'end'));
    expect(existsSync(path)).toBe(false);
  });

  it('releases the lock when the critical section throws', async () => {
    const path = lockPath();
    await expect(withFileLock(path, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(existsSync(path)).toBe(false);
  });

  it('takes over a stale lock left by a crashed holder', async () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 1, at: Date.now() - 120_000 }));
    await expect(withFileLock(path, async () => 'ok', { staleMs: 60_000 })).resolves.toBe('ok');
  });

  it('times out instead of stealing a fresh lock', async () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 1, at: Date.now() }));
    await expect(withFileLock(path, async () => 'ok', { timeoutMs: 50, pollMs: 5 })).rejects.toThrow(/Timed out/);
  });
});
