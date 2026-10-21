import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        // Plain TS: shared/, server modules, bootstrap, adapters, config guards.
        // `#shared` as Nuxt resolves it: app/ code must import shared/ through it, since the SSR build externalizes a
        // relative import from app/ into shared/ with a broken path.
        resolve: { alias: { '#shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['app/**/*.test.ts', 'shared/**/*.test.ts', 'server/**/*.test.ts', 'spikes/**/*.test.ts', 'test/unit/**/*.test.ts'],
        },
      },
      {
        // The built app (`.output/`), started through the production launcher
        // against a throwaway data dir, and driven over HTTP.
        test: {
          name: 'server',
          environment: 'node',
          include: ['test/server/**/*.test.ts'],
          globalSetup: ['test/server/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
