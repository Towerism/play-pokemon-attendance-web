import { describe, expect, it } from 'vitest';
import { shutdownSignals } from './shutdown-signals';

describe('shutdownSignals (the signals the Discord channel drains on, ADR-0015 §7)', () => {
  it("are Nitro's own: SIGTERM and SIGINT unless NITRO_SHUTDOWN_SIGNALS says otherwise", () => {
    expect(shutdownSignals({})).toEqual(['SIGTERM', 'SIGINT']);
    expect(shutdownSignals({ NITRO_SHUTDOWN_SIGNALS: ' SIGTERM  SIGUSR2 ' })).toEqual(['SIGTERM', 'SIGUSR2']);
  });

  it("are none when Nitro's graceful shutdown is off, so a listener never stops Node exiting on the signal", () => {
    expect(shutdownSignals({ NITRO_SHUTDOWN_DISABLED: '1' })).toEqual([]);
  });
});
