import type { Page } from '@playwright/test';
import { createOrganizer, expect, test } from './fixtures';

// A slow navigation leaves the old page on screen until the next one has its
// data, so a thin bar across the top shows that something is happening. It
// waits a moment first, so quick navigations don't flash it.

/** How long a navigation loads before the bar appears. */
const THROTTLE_MS = 200;

/** The bar is decorative and hidden from assistive tech, so it has no role to find it by. */
const bar = (page: Page) => page.locator('.nuxt-loading-indicator');

async function expectBarShown(page: Page): Promise<void> {
  await expect(bar(page)).toHaveCSS('opacity', '1');
}

async function expectBarHidden(page: Page): Promise<void> {
  await expect(bar(page)).toHaveCSS('opacity', '0');
}

/** The theme primary colour as the browser computes it. */
async function themePrimary(page: Page): Promise<string> {
  const color = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.color = 'var(--ui-primary)';
    document.body.append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    return computed;
  });
  expect(color, 'the theme defines a primary colour').not.toBe('');
  return color;
}

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

test('a slow navigation shows a primary-coloured bar over the old page, and it goes once the new page is shown', async ({ page, api: _api }) => {
  await page.goto('/regulars');
  await expect(page.getByRole('heading', { name: 'Regulars' })).toBeVisible();
  await expectBarHidden(page);
  const release = await holdResponses(page, '**/api/sessions/**');

  await page.getByRole('banner').getByRole('link', { name: 'League attendance' }).click();
  await expectBarShown(page);
  await expect(bar(page)).toHaveCSS('background-color', await themePrimary(page));
  await expect(page.getByRole('heading', { name: 'Regulars' })).toBeVisible();

  release();
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
  await expectBarHidden(page);
});

test('the bar waits before it appears, so quick navigations never flash it', async ({ page, api: _api }) => {
  await page.goto('/regulars');
  await expect(page.getByRole('heading', { name: 'Regulars' })).toBeVisible();
  const release = await holdResponses(page, '**/api/sessions/**');
  // Times the tap and the bar's first appearance on the page's own clock.
  await page.evaluate(() => {
    const w = window as unknown as { tappedAt?: number; shownAt?: number };
    document.addEventListener('click', () => (w.tappedAt ??= performance.now()), { capture: true });
    const el = document.querySelector<HTMLElement>('.nuxt-loading-indicator')!;
    new MutationObserver(() => {
      if (el.style.opacity === '1') w.shownAt ??= performance.now();
    }).observe(el, { attributes: true, attributeFilter: ['style'] });
  });

  await page.getByRole('banner').getByRole('link', { name: 'League attendance' }).click();
  await expectBarShown(page);
  const { tappedAt, shownAt } = await page.evaluate(() => {
    const w = window as unknown as { tappedAt: number; shownAt: number };
    return { tappedAt: w.tappedAt, shownAt: w.shownAt };
  });
  expect(shownAt - tappedAt, 'ms from tap to bar').toBeGreaterThanOrEqual(THROTTLE_MS - 1);
  release();
});

test('when another page is opened while one is still loading, the bar goes once that page is shown', async ({ page, api: _api }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/regulars');
  await expect(page.getByRole('heading', { name: 'Regulars' })).toBeVisible();
  const release = await holdResponses(page, '**/api/sessions/**');

  await page.getByRole('banner').getByRole('link', { name: 'This week' }).click();
  await expectBarShown(page);
  await page.getByRole('banner').getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expectBarHidden(page);
  release();
});

test('the bar takes no space, ignores taps and is hidden from assistive tech', async ({ page, api: _api }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'This week' })).toBeVisible();
  await expect(bar(page)).toHaveAttribute('aria-hidden', 'true');
  await expect(bar(page)).toHaveCSS('position', 'fixed');
  await expect(bar(page)).toHaveCSS('height', '3px');
  await expect(bar(page)).toHaveCSS('pointer-events', 'none');
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, 'horizontal page scroll').toBeLessThanOrEqual(innerWidth);
});

test('the login page has the bar too, hidden until a navigation is slow', async ({ page, app }) => {
  await createOrganizer(app);
  await page.goto('/login');
  await expect(bar(page)).toHaveCount(1);
  await expectBarHidden(page);
});
