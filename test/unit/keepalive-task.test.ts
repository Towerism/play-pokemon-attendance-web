import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeepAliveReport } from '../../server/modules/pokemon/connection';

// The hourly task (ADR-0008): one outcome line per professor, tagged with the
// player id, never a token. Nitro's auto-imports are stubbed.

interface Line {
  level: 'info' | 'warn';
  msg: string;
  fields: Record<string, unknown>;
}

let lines: Line[];
let reports: KeepAliveReport[];

beforeEach(() => {
  lines = [];
  vi.stubGlobal('defineTask', (task: unknown) => task);
  vi.stubGlobal('usePokemon', () => ({ keepAliveAll: async () => reports }));
  vi.stubGlobal('useLogger', (_scope: string, fields: Record<string, unknown>) => ({
    info: (msg: string) => lines.push({ level: 'info', msg, fields }),
    warn: (msg: string) => lines.push({ level: 'warn', msg, fields }),
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function run() {
  const task = (await import('../../server/tasks/pokemon/keepalive')).default as unknown as { run: () => Promise<{ result: KeepAliveReport[] }> };
  return task.run();
}

describe('pokemon:keepalive', () => {
  it('logs one outcome per professor, warning on failures and dead logins', async () => {
    reports = [
      { connectionId: 1, professorPlayerId: '0012345', outcome: 'refreshed' },
      { connectionId: 2, professorPlayerId: '0000222', outcome: 'failed', message: 'Pokémon answered 503' },
      { connectionId: 3, professorPlayerId: '333', outcome: 'needs_reconnect' },
      { connectionId: 4, professorPlayerId: null, outcome: 'skipped_recent' },
    ];

    const { result } = await run();

    expect(result).toBe(reports);
    expect(lines).toEqual([
      { level: 'info', msg: 'Keep-alive for professor 0012345: refreshed', fields: { outcome: 'refreshed', professor: '0012345' } },
      { level: 'warn', msg: 'Keep-alive failed for professor 0000222: Pokémon answered 503', fields: { outcome: 'failed', professor: '0000222' } },
      {
        level: 'warn',
        msg: "Keep-alive: professor 333's Pokémon account needs a reconnect (see Settings).",
        fields: { outcome: 'needs_reconnect', professor: '333' },
      },
      { level: 'info', msg: 'Keep-alive for professor connection 4: skipped_recent', fields: { outcome: 'skipped_recent', professor: 'connection 4' } },
    ]);
  });

  it('logs nothing without connections', async () => {
    reports = [];
    await run();
    expect(lines).toEqual([]);
  });
});
