import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

/**
 * Browser journeys against the production build (`pnpm test:e2e`). Each test
 * starts its own app and fake play-tools (`test/e2e/fixtures.ts`), so nothing
 * leaves 127.0.0.1. Chromium at a phone size: attendance is taken on a phone.
 */
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.ts',
  // Builds `.output/` unless TEST_SKIP_BUILD=1 (shared with the server tests).
  globalSetup: './test/server/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    ...devices['Pixel 7'],
    timezoneId: 'America/Chicago',
    trace: CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
