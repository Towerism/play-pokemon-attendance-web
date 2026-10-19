import { describe, expect, it } from 'vitest';

/** ADR-0003: the refresh-token keep-alive runs every hour; ADR-0012: so does the cleanup of abandoned TDF previews. */
describe('hourly tasks', () => {
  it('runs the keep-alive and the TDF preview expiry at the top of every hour', async () => {
    (globalThis as { defineNuxtConfig?: (c: unknown) => unknown }).defineNuxtConfig = (c) => c;
    const { default: config } = (await import('../../nuxt.config')) as unknown as {
      default: { nitro: { experimental?: { tasks?: boolean }; scheduledTasks?: Record<string, string[]> } };
    };

    expect(config.nitro.experimental?.tasks).toBe(true);
    expect(config.nitro.scheduledTasks).toEqual({ '0 * * * *': ['pokemon:keepalive', 'tdf:expire', 'messaging:expire'] });
  });
});
