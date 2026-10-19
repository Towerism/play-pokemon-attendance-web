import { addProfessor, connectAccount, expect, test } from './fixtures';

// Joining through an invite, and resetting a password (ADR-0015 §6, §8; architecture §8). The secret travels in the URL
// fragment; the page drops it from the address bar, and a signed-in browser is told to log out instead.

const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };

test('an invited professor creates their account from a copied link and waits to connect their Pokémon account', async ({ page, browser, connected }) => {
  void connected;
  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Professors' });
  await card.getByRole('button', { name: 'Invite professor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite a professor' });
  await dialog.getByLabel('Label').fill('Misty');
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  const field = dialog.getByLabel('Invite link');
  await expect(field).toHaveValue(/\/invite#ppa_inv_[A-Za-z0-9_-]{43}$/);
  await expect(dialog.getByText('only works where that address does')).toBeVisible();
  const link = await field.inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(card.getByRole('listitem').filter({ hasText: 'Misty' })).toContainText('Expires');
  expect(await page.content()).not.toContain(link.split('#')[1]);

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(link);
  await expect(guest).toHaveURL(/\/invite$/);
  await expect(guest.getByText('Card Shop')).toBeVisible();
  await expect(guest.getByText('Misty')).toBeVisible();
  await guest.getByLabel('Username').fill('misty');
  await guest.getByLabel('Password', { exact: true }).fill('water types');
  await guest.getByLabel('Confirm password').fill('water types');
  await guest.getByRole('button', { name: 'Create account' }).click();

  await expect(guest).toHaveURL(/\/settings$/);
  await expect(guest.getByTestId('waiting')).toHaveText('Connect your Pokémon account to use the league.');
});

test('a signed-in browser opening an invite link is told to log out, without asking the server', async ({ page, connected }) => {
  const minted = await connected.request('/api/professors/invites', { method: 'POST', json: { send: 'copy' } });
  const { secret } = (await minted.json()) as { secret: string };
  const checks: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/invites/check')) checks.push(r.url());
  });

  await page.goto(`/invite#${secret}`);

  await expect(page.getByText("You're signed in as organizer. Log out to use this link.")).toBeVisible();
  expect(checks).toEqual([]);

  // Logging out here still lets them use the link, though the secret already left the address bar.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByLabel('Username')).toBeVisible();
  expect(checks).toHaveLength(1);
});

test('a link that no longer works says so', async ({ browser, app, connected }) => {
  void connected;
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`${app.url}/invite#ppa_inv_${'A'.repeat(43)}`);
  await expect(guest.getByText("This link doesn't work. It may have expired, been used or been revoked. Ask the league's owner for a new one.")).toBeVisible();
});

test('a professor who resets their password waits until they log in to Pokémon as their own account again', async ({ page, browser, app, fake, connected }) => {
  void connected;
  const misty = await addProfessor(app, 'misty');
  const account = fake.addAccount({ playerId: '0000333', name: 'Misty', leagues: [CARD_SHOP] });
  expect((await connectAccount(misty, account.code)).status).toBe(200);

  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Professors' });
  await card.getByRole('button', { name: 'Reset password for misty' }).click();
  const dialog = page.getByRole('dialog', { name: "Reset misty's password" });
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  const link = await dialog.getByLabel('Reset link').inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(link);
  await expect(guest.getByText('Set a new password for misty')).toBeVisible();
  await guest.getByLabel('Password', { exact: true }).fill('new password');
  await guest.getByLabel('Confirm password').fill('new password');
  await guest.getByRole('button', { name: 'Set password' }).click();

  await expect(guest).toHaveURL(/\/settings$/);
  await expect(guest.getByTestId('waiting')).toHaveText("Log in to Pokémon as Professor 0000333 to confirm it's you.");
});
