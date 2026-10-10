import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockOptions {
  /** A lock older than this is assumed abandoned (crashed holder) and taken over. */
  staleMs?: number;
  /** Give up waiting after this long. */
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Cross-process mutex on a lock file (O_EXCL create). Serialises token
 * refreshes between the cron job and manual spike runs: two concurrent
 * refreshes would replay a rotated refresh token, which Hydra may punish by
 * revoking the whole chain (ADR-0003).
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const { staleMs = 60_000, timeoutMs = 30_000, pollMs = 100 } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (lockAge(lockPath) > staleMs) {
        unlinkQuietly(lockPath);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lockPath}`);
      await sleep(pollMs);
    }
  }
  try {
    return await fn();
  } finally {
    unlinkQuietly(lockPath);
  }
}

function lockAge(lockPath: string): number {
  try {
    const { at } = JSON.parse(readFileSync(lockPath, 'utf8')) as { at?: number };
    return typeof at === 'number' ? Date.now() - at : Infinity;
  } catch {
    // Unreadable or half-written: treat as fresh so we don't steal a lock mid-create.
    return 0;
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}
