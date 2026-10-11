import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, type Page, test as base, expect } from '@playwright/test';
import { type FakePlaySession, type FakePokemon, startFakePokemon } from '../server/fake-pokemon';
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

/** The organizer's own staff record, which play-tools lists on every session. */
export const STAFF_ID = '9999991';

/** An open play session in play-tools that still accepts attendance. */
export function playSession(guid: string, startsAt: string): FakePlaySession {
  const end = new Date(Date.parse(startsAt) + 3 * 3600_000).toISOString().replace('.000Z', 'Z');
  return { guid, type: 'open_play', status: 'active', start_date: startsAt, end_date: end, final_modifiable_datetime: '2099-01-01T00:00:00Z', products: ['tcg'] };
}

/** A file under test/e2e/fixtures/. */
export function fixtureFile(name: string): string {
  return fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
}

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
    await shareSession(context, app, api);
    await use(api);
  },

  connected: async ({ api }, use) => {
    await connectOverApi(api);
    await use(api);
  },
});

/** First-run setup over the API, with the code the server printed. Returns a logged-in API client. */
export async function createOrganizer(app: TestServer, who: { username: string; password: string } = OWNER): Promise<Api> {
  const api = client(app.url);
  const res = await api.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(app.logs()), ...who } });
  expect(res.status, 'first-run setup').toBe(200);
  return api;
}

/** Logs the browser in as `api` by copying its session cookie. */
export async function shareSession(context: BrowserContext, app: TestServer, api: Api): Promise<void> {
  for (const pair of api.cookie.split('; ')) {
    const at = pair.indexOf('=');
    await context.addCookies([{ name: pair.slice(0, at), value: pair.slice(at + 1), url: app.url }]);
  }
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

/** A session player added by hand for `date`, over the API. */
export async function addSessionPlayer(api: Api, date: string, playerId: string, name: string): Promise<void> {
  const res = await api.request(`/api/sessions/${date}/players`, { method: 'POST', json: { playerId, name } });
  expect(res.status, `add ${playerId}`).toBe(201);
}

/** Starts a submission for `date` over the API; returns its id without waiting. */
export async function startSubmission(api: Api, date: string, playSessionId: string): Promise<number> {
  const res = await api.request(`/api/sessions/${date}/submissions`, { method: 'POST', json: { playSessionId } });
  expect(res.status, 'start submission').toBe(202);
  return ((await res.json()) as { submissionId: number }).submissionId;
}

/** Waits until submission `id` is no longer planned or running; returns its final status. */
export async function finishedStatus(api: Api, id: number): Promise<string> {
  let status = '';
  await expect
    .poll(async () => {
      status = ((await (await api.request(`/api/submissions/${id}`)).json()) as { status: string }).status;
      return ['planned', 'running'].includes(status);
    }, { message: `submission ${id} to finish`, timeout: 15_000 })
    .toBe(false);
  return status;
}
