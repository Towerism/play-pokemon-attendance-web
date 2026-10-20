import { addProfessor, connectAccount, expect, shareSession, test } from './fixtures';

// Settings → Calendar (ADR-0016 §6): a feed link is shown once, in the dialog after it is made; after that the page
// shows only its hint, a reload included. Rotating gives a new link, and a professor has no public-feed controls.

const LINK = /\/api\/calendar\/v1\/feed\.ics\?token=(ppa_cal_[A-Za-z0-9_-]{43})$/;
const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };

test('the public feed link is shown once, then only by its hint, and can be rotated and turned off', async ({ page, connected }) => {
  void connected;
  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Calendar' });
  const row = card.locator('[data-feed="public"]');
  await expect(row).toContainText('Off');

  await card.getByRole('button', { name: 'Turn on Public feed' }).click();
  const dialog = page.getByRole('dialog', { name: 'Calendar link' });
  const field = dialog.getByLabel('Calendar link');
  await expect(field).toHaveValue(LINK);
  const secret = (await field.inputValue()).match(LINK)![1]!;
  await expect(dialog.getByText('Works only in calendar apps that fetch it from your device')).toBeVisible();
  await expect(dialog.getByRole('link', { name: 'Open in calendar app' })).toHaveAttribute('href', /^webcal:\/\//);
  await expect(dialog.getByRole('button', { name: 'Copy' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();

  await expect(row).toContainText(`ppa_cal_…${secret.slice(-4)}`);
  expect(await page.content()).not.toContain(secret);
  await page.reload();
  await expect(card.locator('[data-feed="public"]')).toContainText(`ppa_cal_…${secret.slice(-4)}`);
  expect(await page.content()).not.toContain(secret);

  page.once('dialog', (d) => {
    expect(d.message()).toContain('Make a new link for the public feed?');
    void d.accept();
  });
  await card.getByRole('button', { name: 'Rotate link of Public feed' }).click();
  const rotated = (await dialog.getByLabel('Calendar link').inputValue()).match(LINK)![1]!;
  expect(rotated).not.toBe(secret);
  await dialog.getByRole('button', { name: 'Done' }).click();

  page.once('dialog', (d) => void d.accept());
  await card.getByRole('button', { name: 'Turn off Public feed' }).click();
  await expect(card.locator('[data-feed="public"]')).toContainText('Off');
});

test('a member professor has their own feed and no public-feed controls', async ({ page, context, app, fake, connected }) => {
  void connected;
  const account = fake.addAccount({ playerId: '0000333', name: 'Misty', leagues: [CARD_SHOP] });
  const misty = await addProfessor(app, 'misty');
  expect((await connectAccount(misty, account.code)).status).toBe(200);
  await context.clearCookies();
  await shareSession(context, app, misty);

  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Calendar' });
  await expect(card.getByRole('button', { name: 'Turn on Your tournaments' })).toBeVisible();
  await expect(card.getByText('Public feed')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Public feed/ })).toHaveCount(0);
});

test('a professor not yet in the league sees no Calendar card', async ({ page, context, app, connected }) => {
  void connected;
  const gary = await addProfessor(app, 'gary');
  await context.clearCookies();
  await shareSession(context, app, gary);

  await page.goto('/settings');
  await expect(page.getByTestId('waiting')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Calendar' })).toHaveCount(0);
});
