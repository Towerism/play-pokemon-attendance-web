import type { Page, Request, Route } from '@playwright/test';
import { type Api, TUESDAY, expect, test } from './fixtures';

// Ticking a regular "present" on This week shows at once, sticks once the
// server answers, and goes back if the server refuses it. No reload needed.

const ASH = '6000020';
const MISTY = '6000021';
const PRESENCE = `**/api/sessions/${TUESDAY}/regulars/*`;

async function regulars(api: Api) {
  for (const [playerId, name] of [[ASH, 'Ash Regular'], [MISTY, 'Misty Regular']]) {
    expect((await api.request('/api/regulars', { method: 'POST', json: { playerId, name } })).status).toBe(201);
  }
}

/** This week for TUESDAY with the Regulars list open. */
async function openRegulars(page: Page) {
  await page.goto(`/?date=${TUESDAY}`);
  await regularsToggle(page).click();
}

const regularsToggle = (page: Page) => page.getByRole('button', { name: /^Regulars \(/ });
const checkbox = (page: Page, name: string) => page.getByRole('checkbox', { name });

/** Holds every presence PUT until the test opens the gate, then lets it reach the real server. */
function holdPresence(page: Page) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const held: Route[] = [];
  void page.route(PRESENCE, async (route) => {
    held.push(route);
    await gate;
    await route.continue();
  });
  return { open, held };
}

/** Requests the page sends after this call: presence PUTs and session refetches. */
function watchRequests(page: Page) {
  const puts: Request[] = [];
  const sessionGets: Request[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (r.method() === 'PUT' && path.startsWith(`/api/sessions/${TUESDAY}/regulars/`)) puts.push(r);
    if (r.method() === 'GET' && path === `/api/sessions/${TUESDAY}`) sessionGets.push(r);
  });
  return { puts, sessionGets };
}

test('ticking a regular shows at once and sticks once the server answers, without a reload', async ({ page, api }) => {
  await regulars(api);
  await openRegulars(page);
  await expect(checkbox(page, 'Ash Regular')).not.toBeChecked();
  await expect(regularsToggle(page)).toContainText('0 present');

  const { open, held } = holdPresence(page);
  const { puts, sessionGets } = watchRequests(page);
  await checkbox(page, 'Ash Regular').click();

  // Before the server answers: ticked, and counted.
  await expect.poll(() => held.length).toBe(1);
  await expect(checkbox(page, 'Ash Regular')).toBeChecked();
  await expect(regularsToggle(page)).toContainText('1 present');
  await expect(checkbox(page, 'Misty Regular')).not.toBeChecked();

  // The server answers: still ticked, one PUT, no refetch.
  const answered = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/regulars/${ASH}`));
  open();
  expect((await answered).status()).toBe(200);
  await expect(checkbox(page, 'Ash Regular')).toBeChecked();
  await expect(regularsToggle(page)).toContainText('1 present');
  expect(puts).toHaveLength(1);
  expect(puts[0]!.postDataJSON()).toEqual({ present: true });
  expect(sessionGets).toHaveLength(0);

  // Saved.
  await page.unroute(PRESENCE);
  await openRegulars(page);
  await expect(checkbox(page, 'Ash Regular')).toBeChecked();
});

test('unticking a ticked regular shows at once and is saved', async ({ page, api }) => {
  await regulars(api);
  expect((await api.request(`/api/sessions/${TUESDAY}/regulars/${ASH}`, { method: 'PUT', json: { present: true } })).status).toBe(200);
  await openRegulars(page);
  await expect(checkbox(page, 'Ash Regular')).toBeChecked();
  await expect(regularsToggle(page)).toContainText('1 present');

  const answered = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/regulars/${ASH}`));
  await checkbox(page, 'Ash Regular').click();
  await expect(checkbox(page, 'Ash Regular')).not.toBeChecked();
  await expect(regularsToggle(page)).toContainText('0 present');
  expect((await answered).status()).toBe(200);
  await expect(checkbox(page, 'Ash Regular')).not.toBeChecked();

  await openRegulars(page);
  await expect(checkbox(page, 'Ash Regular')).not.toBeChecked();
});

test('a tick the server refuses goes back and says why', async ({ page, api }) => {
  await regulars(api);
  await openRegulars(page);
  await page.route(PRESENCE, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', json: { statusCode: 404, message: 'Not a regular' } }),
  );

  const answered = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/regulars/${ASH}`));
  await checkbox(page, 'Ash Regular').click();
  expect((await answered).status()).toBe(404);

  // The toast, plus the copy its live region announces.
  await expect(page.getByText('Not a regular').first()).toBeVisible();
  await expect(checkbox(page, 'Ash Regular')).not.toBeChecked();
  await expect(regularsToggle(page)).toContainText('0 present');
});
