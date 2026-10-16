import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogBuffer } from '../server/log-buffer';

// The server's log reaches a test through the child's pipes, a separate channel from
// its HTTP responses, so a line can arrive after the response that caused it (#123).
// Chunks are fed in by hand here, and deadlines run on fake timers.

const SETUP_LINE = '[2026-10-13 22:14:59.979] INFO: [setup] No organizer account yet. Open the app and enter this setup code: ABCD-EF23\n';

let logs: LogBuffer;
beforeEach(() => {
  vi.useFakeTimers();
  logs = new LogBuffer();
});
afterEach(() => vi.useRealTimers());

describe('waiting for a log line', () => {
  it('resolves with a line that is already there, without any time passing', async () => {
    logs.append('[…] INFO: [startup] Session password: generated\n');
    logs.append(SETUP_LINE);

    const match = await logs.waitFor(/setup code: ([A-Z2-9]{4}-[A-Z2-9]{4})/);

    expect(match[1]).toBe('ABCD-EF23');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a line that arrives after the wait began', async () => {
    logs.append('[…] INFO: [startup] Session password: generated\n');
    const waiting = logs.waitFor(/setup code: ([A-Z2-9]{4}-[A-Z2-9]{4})/);

    logs.append(SETUP_LINE);

    expect((await waiting)[1]).toBe('ABCD-EF23');
  });

  it('matches only complete lines, so a line split across chunks never matches half-written', async () => {
    const waiting = logs.waitFor(/setup code: (\S+)/);

    logs.append(SETUP_LINE.slice(0, -4));
    expect(await settled(waiting)).toBe(false);

    logs.append(SETUP_LINE.slice(-4));
    expect((await waiting)[1]).toBe('ABCD-EF23');
  });

  it('from an offset, ignores a match before it and waits for a new one', async () => {
    logs.append(SETUP_LINE);
    const waiting = logs.waitFor(/setup code: ([A-Z2-9]{4}-[A-Z2-9]{4})/, { from: logs.text().length });
    expect(await settled(waiting)).toBe(false);

    logs.append(SETUP_LINE.replace('ABCD-EF23', 'WXYZ-2345'));

    expect((await waiting)[1]).toBe('WXYZ-2345');
  });

  it.each(['g', 'y'])('returns the first match with its groups whatever a %s flag would do', async (flag) => {
    logs.append('[…] INFO: [startup] Session password: generated\n');
    logs.append(SETUP_LINE);
    logs.append(SETUP_LINE.replace('ABCD-EF23', 'WXYZ-2345'));

    const match = await logs.waitFor(new RegExp('setup code: ([A-Z2-9]{4}-[A-Z2-9]{4})', flag));

    expect([match[0], match[1]]).toEqual(['setup code: ABCD-EF23', 'ABCD-EF23']);
  });

  it('resolves several waits on different lines independently', async () => {
    const setup = logs.waitFor(/setup code/);
    const listening = logs.waitFor(/Listening on/);

    logs.append('Listening on http://127.0.0.1:3000\n');
    expect([await settled(setup), await settled(listening)]).toEqual([false, true]);

    logs.append(SETUP_LINE);
    await expect(setup).resolves.toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('giving up', () => {
  it('rejects after 5 s by default, naming the pattern and showing the output so far', async () => {
    logs.append('[…] INFO: [startup] Session password: generated\n');
    const waiting = logs.waitFor(/setup code/);
    const outcome = expect(waiting).rejects.toThrow(/timed out after 5000ms waiting for \/setup code\/ in logs:\n.*Session password: generated/);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settled(waiting)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await outcome;
  });

  it('takes a shorter deadline', async () => {
    const outcome = expect(logs.waitFor(/setup code/, { timeoutMs: 200 })).rejects.toThrow(/timed out after 200ms/);

    await vi.advanceTimersByTimeAsync(200);

    await outcome;
  });

  it('leaves no timer behind once the line arrives', async () => {
    const waiting = logs.waitFor(/setup code/);
    logs.append(SETUP_LINE);
    await waiting;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects as soon as the process exits without the line, with the exit code, not at the deadline', async () => {
    logs.append('[…] ERROR: [startup] NUXT_TOKEN_VAULT_KEY is not a valid key\n');
    const waiting = logs.waitFor(/setup code/);
    const outcome = expect(waiting).rejects.toThrow(/server exited \(code 1\) before \/setup code\/ appeared in logs:\n.*NUXT_TOKEN_VAULT_KEY/);

    logs.close({ code: 1, signal: null });

    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a wait started after the process was stopped, naming the signal', async () => {
    logs.close({ code: null, signal: 'SIGTERM' });

    await expect(logs.waitFor(/setup code/)).rejects.toThrow(/server exited \(signal SIGTERM\) before \/setup code\//);
  });

  it('still finds a line that arrived just before the process exited', async () => {
    const waiting = logs.waitFor(/setup code: ([A-Z2-9]{4}-[A-Z2-9]{4})/);

    logs.append(SETUP_LINE);
    logs.close({ code: 0, signal: null });

    expect((await waiting)[1]).toBe('ABCD-EF23');
    await expect(logs.waitFor(/setup code: ([A-Z2-9]{4}-[A-Z2-9]{4})/)).resolves.toBeTruthy();
  });
});

/** Whether `promise` has settled once pending microtasks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await Promise.resolve();
  await Promise.resolve();
  return done;
}
