import { writeFileSync } from 'node:fs';
import { type Page, test as base, expect } from '@playwright/test';
import { type FakePokemon, startFakePokemon } from '../server/fake-pokemon';
import { type TestServer, client, setupCodeFrom, startServer } from '../server/harness';

export { expect };

export const OWNER = { username: 'organizer', password: 'correct horse' };

/** The league's Tuesday: its evening session starts on Wednesday in UTC, so the TZ must be honoured. */
export const TUESDAY = '2026-10-13';

const APP_ENV = {
  TZ: 'America/Chicago',
  NUXT_SUBMISSION_BATCH_DELAY_MS: '0',
  // The smallest undo pacing the app accepts.
  NUXT_UNDO_DELAY_MS: '500',
};

export type Api = ReturnType<typeof client>;

interface Fixtures {
  /** A fresh fake play-tools for this test. */
  fake: FakePokemon;
  /** A fresh app (the production build) on its own port and data dir, pointed at `fake`. */
  app: TestServer;
  /** Requests the browser tried to send outside the app and the fake; must stay empty. */
  blockedRequests: string[];
  /** The organizer account, created over the API, logged in both here and in the browser. */
  api: Api;
  /** `api`, with a Pokémon account connected (paste-back) and its only league bound. */
  connected: Api;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern.
  fake: async ({}, use) => {
    const fake = await startFakePokemon();
    await use(fake);
    await fake.close();
  },

  app: async ({ fake }, use, testInfo) => {
    const app = await startServer({ env: { ...fake.env, ...APP_ENV } });
    try {
      await use(app);
    } finally {
      await app.stop();
      if (testInfo.status !== testInfo.expectedStatus) {
        const path = testInfo.outputPath('server.log');
        writeFileSync(path, app.logs());
        await testInfo.attach('server.log', { path, contentType: 'text/plain' });
      }
      await app.dispose();
    }
    // Tokens never reach the log, whatever the journey did.
    expect(app.logs(), 'a token reached the server log').not.toMatch(/ory_rt_|eyJ/);
  },

  baseURL: async ({ app }, use) => {
    await use(app.url);
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern.
  blockedRequests: async ({}, use) => {
    const blocked: string[] = [];
    await use(blocked);
    expect(blocked, 'the browser tried to reach outside the test').toEqual([]);
  },

  context: async ({ context, app, fake, blockedRequests }, use) => {
    const allowed = new Set([new URL(app.url).origin, new URL(fake.url).origin]);
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (allowed.has(new URL(url).origin)) return route.continue();
      blockedRequests.push(url);
      return route.abort('blockedbyclient');
    });
    await use(context);
  },

  api: async ({ app, context }, use) => {
    const api = await createOrganizer(app);
    for (const pair of api.cookie.split('; ')) {
      const at = pair.indexOf('=');
      await context.addCookies([{ name: pair.slice(0, at), value: pair.slice(at + 1), url: app.url }]);
    }
    await use(api);
  },

  connected: async ({ api }, use) => {
    await connectOverApi(api);
    await use(api);
  },
});

/** First-run setup over the API, with the code the server printed. Returns a logged-in API client. */
export async function createOrganizer(app: TestServer): Promise<Api> {
  const api = client(app.url);
  const res = await api.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(app.logs()), ...OWNER } });
  expect(res.status, 'first-run setup').toBe(200);
  return api;
}

/** Paste-back connect over the API, the way the Settings card does it. */
export async function connectOverApi(api: Api): Promise<void> {
  const start = await api.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL(((await start.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state');
  const res = await api.request('/api/pokemon/connect/complete', { method: 'POST', json: { url: loggedInUrl(state!) } });
  expect(res.status, 'connect').toBe(200);
}

/** The play-tools address the organizer pastes back after logging in at Pokémon. */
export function loggedInUrl(state: string): string {
  return `https://play-tools.pokemon.com/loggedIn?code=e2e&state=${state}`;
}

/** Fill and submit the login form on /login. */
export async function logIn(page: Page, who: { username: string; password: string }): Promise<void> {
  await page.getByLabel('Username').fill(who.username);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Log in' }).click();
}
