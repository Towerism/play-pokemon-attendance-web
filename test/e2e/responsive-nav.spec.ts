import type { Locator, Page } from '@playwright/test';
import { OWNER, connectOverApi, createOrganizer, expect, shareSession, test } from './fixtures';

// On a phone the header holds the brand and one menu button; the links and
// Log out live in a drawer. From `sm` (640 px) up it stays one inline row.

const LINKS = ['This week', 'Regulars', 'Players', 'Tournaments', 'History', 'Settings'];
const PHONE = { width: 360, height: 780 };
/** Comfortable phone tap size, above the WCAG 2.2 minimum of 24 px. */
const TAP = 44;

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, 'a rendered box').not.toBeNull();
  return box!;
}

/** Big enough to tap, and wholly on screen. */
async function expectTappable(page: Page, locator: Locator): Promise<Box> {
  const box = await boxOf(locator);
  const { width } = page.viewportSize()!;
  expect(box.width, 'tap width').toBeGreaterThanOrEqual(TAP);
  expect(box.height, 'tap height').toBeGreaterThanOrEqual(TAP);
  expect(box.x, 'left edge on screen').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'right edge on screen').toBeLessThanOrEqual(width);
  return box;
}

function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function expectNoOverlap(boxes: Box[]): void {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i]!, boxes[j]!), `controls ${i} and ${j} overlap`).toBe(false);
  }
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, 'horizontal page scroll').toBeLessThanOrEqual(innerWidth);
}

const header = (page: Page) => page.getByRole('banner');
const menuButton = (page: Page) => header(page).getByRole('button', { name: 'Open menu' });
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Menu' });

/** Opens the drawer and waits for its slide-in to finish, so its boxes are final. */
async function openMenu(page: Page): Promise<void> {
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();
  await drawer(page).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
}

/** The header the organizer sees on a phone, with the drawer closed. */
async function expectPhoneHeader(page: Page): Promise<void> {
  await expect(header(page).getByRole('link', { name: 'League attendance' })).toBeVisible();
  await expect(menuButton(page)).toBeVisible();
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  for (const name of LINKS) await expect(header(page).getByRole('link', { name, exact: true })).toBeHidden();
  await expect(header(page).getByRole('button', { name: 'Log out' })).toBeHidden();
  const brand = await boxOf(header(page).getByRole('link', { name: 'League attendance' }));
  expectNoOverlap([brand, await expectTappable(page, menuButton(page))]);
  await expectNoHorizontalScroll(page);
}

/** Every control in the open drawer is tappable, on screen and clear of the others. */
async function expectDrawerFits(page: Page): Promise<void> {
  const controls = [...LINKS.map((name) => drawer(page).getByRole('link', { name, exact: true })), drawer(page).getByRole('button', { name: 'Log out' }), drawer(page).getByRole('button', { name: 'Close menu' })];
  const boxes: Box[] = [];
  for (const control of controls) boxes.push(await expectTappable(page, control));
  expectNoOverlap(boxes);
  await expectNoHorizontalScroll(page);
}

test('a phone header shows the brand and a menu button, never overlapping controls', async ({ page, api: _api }) => {
  for (const width of [320, 360, 412]) {
    await page.setViewportSize({ width, height: 780 });
    await page.goto('/regulars');
    await expectPhoneHeader(page);
  }
});

test('the menu drawer lists every page in order, marks the current one, and fits the phone', async ({ page, api: _api }) => {
  for (const width of [320, 360, 412]) {
    await page.setViewportSize({ width, height: 780 });
    await page.goto('/settings');
    await openMenu(page);
    // The open modal hides the page behind it from assistive tech, the menu button included.
    await expect(page.getByRole('button', { name: 'Open menu', includeHidden: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(drawer(page).getByRole('link')).toHaveText(LINKS);
    await expect(drawer(page).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    await expect(drawer(page).getByRole('link', { name: 'This week' })).not.toHaveAttribute('aria-current', 'page');
    await expect(drawer(page).getByText(OWNER.username, { exact: true })).toBeVisible();
    await expectDrawerFits(page);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toBeHidden();
  }
});

test('tapping a page in the drawer opens it and closes the drawer', async ({ page, api: _api }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await openMenu(page);
  await drawer(page).getByRole('link', { name: 'History' }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(drawer(page)).toBeHidden();
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
});

/** Holds every response matching `url` until the returned function is called, so the next page stays loading. */
async function holdResponses(page: Page, url: string): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(url, async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

/** Lets any pending route update and close transition start before the drawer's state is read. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('a drawer opened while the next page is loading stays open once it has loaded', async ({ page, api: _api }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/regulars');
  await expect(page.getByRole('heading', { name: 'Regulars' })).toBeVisible();
  const release = await holdResponses(page, '**/api/sessions/**');

  await header(page).getByRole('link', { name: 'League attendance' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'This week' })).toBeHidden();
  await openMenu(page);

  release();
  // The open drawer hides the page behind it from assistive tech, so the heading is looked up with hidden ones.
  await expect(page.getByRole('heading', { name: 'This week', includeHidden: true })).toBeVisible();
  await settle(page);
  await expect(drawer(page)).toHaveAttribute('data-state', 'open');
  await drawer(page).getByRole('link', { name: 'Regulars' }).click();
  await expect(page).toHaveURL(/\/regulars$/);
  await expect(drawer(page)).toBeHidden();
});

test('tapping a page in the drawer closes it before that page has loaded', async ({ page, api: _api }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await openMenu(page);
  const release = await holdResponses(page, '**/api/submissions**');

  await drawer(page).getByRole('link', { name: 'History' }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(drawer(page)).toBeHidden();
  await expect(page.getByRole('heading', { name: 'History' })).toBeHidden();

  release();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
});

test('Log out in the drawer ends the session', async ({ page, api: _api }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await openMenu(page);
  await drawer(page).getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('the drawer closes on Escape, its close button, or a tap outside, and focus returns to the menu button', async ({ page, api: _api }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  const dismissals: Array<[string, () => Promise<void>]> = [
    ['Escape', () => page.keyboard.press('Escape')],
    ['close button', () => drawer(page).getByRole('button', { name: 'Close menu' }).click()],
    // The drawer opens from the right, so the far left of the screen is outside it.
    ['tap outside', () => page.mouse.click(5, PHONE.height / 2)],
  ];
  for (const [how, dismiss] of dismissals) {
    await openMenu(page);
    await expect(drawer(page), how).toBeVisible();
    await dismiss();
    await expect(drawer(page), how).toBeHidden();
    await expect(menuButton(page), how).toBeFocused();
  }
});

test('a long username stays inside the drawer', async ({ page, app, context }) => {
  // The longest username setup accepts, in wide letters.
  const username = 'w'.repeat(32);
  await shareSession(context, app, await createOrganizer(app, { username, password: OWNER.password }));

  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('/');
  await openMenu(page);
  const name = await boxOf(drawer(page).getByText(username, { exact: true }));
  expect(name.x + name.width, 'username right edge on screen').toBeLessThanOrEqual(320);
  await expectDrawerFits(page);
});

test('the reconnect banner does not crowd the phone header', async ({ page, fake, api }) => {
  fake.accessTtl = 60;
  await connectOverApi(api);
  fake.revokeChain();
  // Any upstream call now finds the saved login refused.
  await api.request('/api/leagues/upstream?professor=9999991');

  await page.setViewportSize(PHONE);
  await page.goto('/');
  await expect(page.getByText('Pokémon no longer accepts Professor 9999991’s login.', { exact: false })).toBeVisible();
  await expectPhoneHeader(page);
  await openMenu(page);
  await expectDrawerFits(page);
});

test('a desktop header keeps the inline row and no menu button', async ({ page, api: _api }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/');
  await expect(menuButton(page)).toBeHidden();
  const controls = [...LINKS.map((name) => header(page).getByRole('link', { name, exact: true })), header(page).getByRole('button', { name: 'Log out' })];
  const centres: number[] = [];
  for (const control of controls) {
    await expect(control).toBeVisible();
    const box = await boxOf(control);
    centres.push(box.y + box.height / 2);
  }
  expect(Math.max(...centres) - Math.min(...centres), 'one row').toBeLessThanOrEqual(4);
});

test('a logged-out phone header has no menu, links or Log out', async ({ page, app }) => {
  await createOrganizer(app);
  await page.setViewportSize(PHONE);
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Log out' })).toHaveCount(0);
  for (const name of LINKS) await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
