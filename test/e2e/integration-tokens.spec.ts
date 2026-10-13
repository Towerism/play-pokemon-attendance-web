import { expect, test } from './fixtures';

// Settings → Integrations (#115): a token for Tournament Genie is shown once, at creation. After the dialog
// closes, the page only ever shows its hint, a reload included, and revoking it takes it off the list.

const SECRET = /^ppa_int_[A-Za-z0-9_-]{43}$/;

test('a new integration token is shown once, then only by its hint, and can be revoked', async ({ page, api }) => {
  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Integrations' });
  await expect(card.getByText('No integration tokens yet.')).toBeVisible();

  await card.getByLabel('Token name').fill('Genie');
  await card.getByRole('button', { name: 'Create token' }).click();

  const dialog = page.getByRole('dialog', { name: 'Integration token created' });
  const field = dialog.getByLabel('Integration token');
  await expect(field).toHaveValue(SECRET);
  const secret = await field.inputValue();
  await expect(dialog.getByRole('button', { name: 'Copy' })).toBeVisible();
  await expect(dialog.getByText("won't be shown again")).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();

  const row = card.getByRole('listitem').filter({ hasText: 'Genie' });
  await expect(row).toContainText(`ppa_int_…${secret.slice(-4)}`);
  await expect(row).toContainText('Never used');
  await expect(page.locator('body')).not.toContainText(secret);
  expect(await page.content()).not.toContain(secret);

  await page.reload();
  await expect(card.getByRole('listitem').filter({ hasText: 'Genie' })).toBeVisible();
  expect(await page.content()).not.toContain(secret);

  page.once('dialog', (d) => {
    expect(d.message()).toContain('Genie');
    void d.accept();
  });
  await card.getByRole('button', { name: 'Revoke Genie' }).click();
  await expect(card.getByText('No integration tokens yet.')).toBeVisible();
  expect((await (await api.request('/api/integrations/tokens')).json()).tokens).toEqual([]);
});
