import type { Page, Request } from '@playwright/test';
import { type Api, TUESDAY, addSessionPlayer, expect, test } from './fixtures';

// Adding a known player to the session by searching part of their name or ID,
// instead of typing the whole ID again.

const LAST_WEEK = '2026-10-06';
const KETCHUM = '6000011';
const OAK = '6000012';
const NAMELESS = '6000013';
const REGULAR = '6000020';
const ALREADY = '6000030';

/** Players the app knows from earlier weeks, a regular, and one already in this week's session. */
async function knownPlayers(api: Api) {
  await addSessionPlayer(api, LAST_WEEK, KETCHUM, 'Ash Ketchum');
  await addSessionPlayer(api, LAST_WEEK, OAK, 'Ashley Oak');
  await addSessionPlayer(api, LAST_WEEK, NAMELESS, '');
  expect((await api.request('/api/regulars', { method: 'POST', json: { playerId: REGULAR, name: 'Ash Regular' } })).status).toBe(201);
  await addSessionPlayer(api, TUESDAY, ALREADY, 'Ash Already');
}

const searchBox = (page: Page) => page.getByRole('combobox', { name: 'Find a known player' });
const sessionRow = (page: Page, playerId: string) => page.getByRole('table').first().getByRole('row').filter({ hasText: playerId });
const option = (page: Page, text: string) => page.getByRole('option').filter({ hasText: text });

test('search finds known players by part of a name or id and adds them by hand', async ({ page, api }) => {
  await knownPlayers(api);
  const searches: URL[] = [];
  page.on('request', (r: Request) => {
    if (r.url().includes('/api/players')) searches.push(new URL(r.url()));
  });
  await page.goto(`/?date=${TUESDAY}`);
  const search = searchBox(page);

  // One character is too short to search.
  await search.pressSequentially('a');
  await page.waitForTimeout(600);
  expect(searches).toHaveLength(0);

  // Two or more: one capped search for what was typed.
  const ash = page.waitForRequest((r) => new URL(r.url()).searchParams.get('q') === 'ash');
  await search.pressSequentially('sh');
  expect(new URL((await ash).url()).searchParams.get('limit')).toBe('20');

  // A regular and a player already in the session show up, but can't be picked.
  await expect(option(page, 'Ash Ketchum')).toBeVisible();
  await expect(option(page, 'Ash Regular')).toContainText('Regular');
  await expect(option(page, 'Ash Regular')).toHaveAttribute('aria-disabled', 'true');
  await expect(option(page, 'Ash Already')).toContainText('Already added');
  await expect(option(page, 'Ash Already')).toHaveAttribute('aria-disabled', 'true');
  await expect(option(page, 'Ash Ketchum')).not.toHaveAttribute('aria-disabled', 'true');

  // Keyboard only: arrow to an addable player and press Enter.
  await search.press('ArrowDown');
  const highlighted = page.locator('[role="option"][data-highlighted]');
  await expect(highlighted).not.toHaveAttribute('aria-disabled', 'true');
  const picked = (await highlighted.textContent())!.match(/\d{7}/)![0];
  await search.press('Enter');

  await expect(sessionRow(page, picked)).toContainText('By hand');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();

  // Part of an id; a player with no name reads "No name".
  await search.fill('600001');
  await expect(option(page, NAMELESS)).toContainText('No name');
  await option(page, NAMELESS).click();
  await expect(sessionRow(page, NAMELESS)).toContainText('By hand');

  // Nothing matches.
  await search.fill('zzz');
  await expect(page.getByText('No known players match. Add them by ID below.')).toBeVisible();
});

test('a player who became a regular meanwhile is refused with the reason, and the search stays', async ({ page, api }) => {
  await knownPlayers(api);
  await page.goto(`/?date=${TUESDAY}`);
  const search = searchBox(page);

  await search.fill('Ashley');
  await expect(option(page, 'Ashley Oak')).toBeVisible();
  // Someone makes them a regular in another tab.
  expect((await api.request('/api/regulars', { method: 'POST', json: { playerId: OAK } })).status).toBe(201);
  await option(page, 'Ashley Oak').click();

  await expect(page.getByText(`Player ${OAK} is a regular and is already submitted every session.`).first()).toBeVisible();
  await expect(search).toHaveValue('Ashley');
  await expect(sessionRow(page, OAK)).toHaveCount(0);
});

test('a failed search says so in the box, without a toast', async ({ page, api }) => {
  await knownPlayers(api);
  await page.route('**/api/players?**', (route) => route.fulfill({ status: 500, json: { statusCode: 500, message: 'boom' } }));
  await page.goto(`/?date=${TUESDAY}`);

  await searchBox(page).fill('ash');

  await expect(page.getByText('Search failed. Try again.')).toHaveCount(1);
  await expect(page.getByText('boom')).toHaveCount(0);
});

test('changing the date clears the search', async ({ page, api }) => {
  await knownPlayers(api);
  await page.goto(`/?date=${TUESDAY}`);
  const search = searchBox(page);
  await search.fill('ash');
  await expect(option(page, 'Ash Ketchum')).toBeVisible();

  await page.getByLabel('Session date').fill(LAST_WEEK);

  await expect(search).toHaveValue('');
  await expect(page.getByRole('option')).toHaveCount(0);
});

test('the search fits a phone screen', async ({ page, api }) => {
  await knownPlayers(api);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/?date=${TUESDAY}`);

  await searchBox(page).fill('ash');
  await expect(option(page, 'Ash Ketchum')).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
