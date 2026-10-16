import { describe, expect, it } from 'vitest';
import { logRecords, waitForSetupCode } from '../server/harness';
import { LogBuffer } from '../server/log-buffer';

describe('reading JSON log records', () => {
  it('skips a record still being written, instead of failing to parse it', () => {
    const logs = 'Listening on http://127.0.0.1:3000\n{"level":30,"scope":"setup","msg":"ready"}\n{"level":30,"scope":"ht';

    expect(logRecords(logs)).toEqual([{ level: 30, scope: 'setup', msg: 'ready' }]);
  });
});

describe('the setup code', () => {
  it.each([
    ['pretty', '[2026-10-13 22:14:59.979] INFO: [setup] No organizer account yet. Open the app and enter this setup code: ABCD-EF23\n'],
    ['json', '{"level":30,"scope":"setup","msg":"No organizer account yet. Open the app and enter this setup code: ABCD-EF23"}\n'],
  ])('waits for the %s line and returns the code', async (_format, line) => {
    const logs = new LogBuffer();
    const code = waitForSetupCode(logs);

    logs.append('[…] INFO: [startup] Session password: generated\n');
    logs.append(line);

    await expect(code).resolves.toBe('ABCD-EF23');
  });
});
