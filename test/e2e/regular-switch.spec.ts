import type { Page, Request, Route } from '@playwright/test';
import { type Api, expect, test } from './fixtures';

// Flipping a player's Regular switch on Players shows at once, sticks once the
// server answers, and goes back if the server refuses it.

const ASH = '6000030';
const MISTY = '6000031';
const PLAYER = '**/api/players/*';

async function players(api: Api, { regular }: { regular: boolean }) {
  for (const [playerId, name] of [[ASH, 'Ash Ketchum'], [MISTY, 'Misty Waterflower']]) {
    expect((await api.request('/api/regulars', { method: 'POST', json: { playerId, name } })).status).toBe(201);
    if (!regular) {
      expect((await api.request(`/api/players/${playerId}`, { method: 'PATCH', json: { isRegular: false } })).status).toBe(200);
    }
  }
}

const openAll = (page: Page) => page.goto('/players?tab=all');
const regularSwitch = (page: Page, name: string) => page.getByRole('switch', { name: `${name} is a regular` });

/** Holds every player PATCH until the test opens the gate, then lets it reach the real server. */
function holdPatches(page: Page) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const held: Route[] = [];
  void page.route(PLAYER, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    held.push(route);
    await gate;
    await route.continue();
  });
  return { open, held };
}

function watchPatches(page: Page) {
  const patches: Request[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && new URL(r.url()).pathname.startsWith('/api/players/')) patches.push(r);
  });
  return patches;
}

const answered = (page: Page, playerId: string) =>
  page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/players/${playerId}`));

test('turning the switch on shows at once and sticks once the server answers', async ({ page, api }) => {
  await players(api, { regular: false });
  await openAll(page);
  await expect(regularSwitch(page, 'Ash Ketchum')).not.toBeChecked();

  const { open, held } = holdPatches(page);
  const patches = watchPatches(page);
  await regularSwitch(page, 'Ash Ketchum').click();

  // Before the server answers: on, and only for Ash.
  await expect.poll(() => held.length).toBe(1);
  await expect(regularSwitch(page, 'Ash Ketchum')).toBeChecked();
  await expect(regularSwitch(page, 'Misty Waterflower')).not.toBeChecked();

  // The server answers: still on, one PATCH.
  const response = answered(page, ASH);
  open();
  expect((await response).status()).toBe(200);
  await expect(regularSwitch(page, 'Ash Ketchum')).toBeChecked();
  expect(patches).toHaveLength(1);
  expect(patches[0]!.postDataJSON()).toEqual({ isRegular: true });

  // Saved.
  await page.unroute(PLAYER);
  await openAll(page);
  await expect(regularSwitch(page, 'Ash Ketchum')).toBeChecked();
});

test('turning a regular off shows at once and is saved', async ({ page, api }) => {
  await players(api, { regular: true });
  await openAll(page);
  await expect(regularSwitch(page, 'Ash Ketchum')).toBeChecked();

  const { open, held } = holdPatches(page);
  await regularSwitch(page, 'Ash Ketchum').click();
  await expect.poll(() => held.length).toBe(1);
  await expect(regularSwitch(page, 'Ash Ketchum')).not.toBeChecked();

  const response = answered(page, ASH);
  open();
  expect((await response).status()).toBe(200);
  await expect(regularSwitch(page, 'Ash Ketchum')).not.toBeChecked();

  await page.unroute(PLAYER);
  await openAll(page);
  await expect(regularSwitch(page, 'Ash Ketchum')).not.toBeChecked();
});

test('a flip the server refuses goes back and says why', async ({ page, api }) => {
  await players(api, { regular: false });
  await openAll(page);

  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  await page.route(PLAYER, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    await gate;
    await route.fulfill({ status: 404, contentType: 'application/json', json: { statusCode: 404, message: 'Player not found' } });
  });

  const response = answered(page, ASH);
  await regularSwitch(page, 'Ash Ketchum').click();
  // The flip shows while the request is out, so its rollback is a visible change.
  await expect(regularSwitch(page, 'Ash Ketchum')).toBeChecked();
  open();
  expect((await response).status()).toBe(404);

  // The toast, plus the copy its live region announces.
  await expect(page.getByText('Player not found').first()).toBeVisible();
  await expect(regularSwitch(page, 'Ash Ketchum')).not.toBeChecked();
});
