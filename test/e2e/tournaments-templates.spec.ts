import { expect, test } from './fixtures';

// Templates (ADR-0010 decision 10, #98): the form's choices are read live from play-tools as the organizer, so the
// venue and format come from the fake, never typed in.

test('a new template takes its format and venue from play-tools and is listed', async ({ page, connected: _connected }) => {
  await page.goto('/tournaments?tab=templates');
  await page.getByRole('button', { name: 'New template' }).click();
  const dialog = page.getByRole('dialog', { name: 'New template' });
  await dialog.getByLabel('Name').fill('Weekly Cup {month}');
  await dialog.getByRole('combobox', { name: 'Organizer' }).click();
  await page.getByRole('option').first().click();
  await dialog.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'tcg_std' }).click();
  await dialog.getByRole('combobox', { name: 'Venue' }).click();
  await page.getByRole('option', { name: 'Card Shop' }).click();
  await dialog.getByLabel('Contact email').fill('league@example.com');
  await dialog.getByRole('button', { name: 'Save template' }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole('listitem', { name: 'Weekly Cup {month}' })).toContainText('Card Shop');
});

test('admission takes a dollar amount: other text blocks saving, and Free is one click (#194)', async ({ page, connected: _connected }) => {
  await page.goto('/tournaments?tab=templates');
  await page.getByRole('button', { name: 'New template' }).click();
  const dialog = page.getByRole('dialog', { name: 'New template' });
  await dialog.getByLabel('Name').fill('Priced Cup');
  await dialog.getByRole('combobox', { name: 'Organizer' }).click();
  await page.getByRole('option').first().click();
  await dialog.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'tcg_std' }).click();
  await dialog.getByRole('combobox', { name: 'Venue' }).click();
  await page.getByRole('option', { name: 'Card Shop' }).click();
  await dialog.getByLabel('Contact email').fill('league@example.com');
  const admission = dialog.getByLabel('Admission');
  const save = dialog.getByRole('button', { name: 'Save template' });

  await admission.fill('abc');
  await expect(dialog.getByText('Enter an amount such as 10 or 7.50').first()).toBeVisible();
  await expect(save).toBeDisabled();

  await dialog.getByRole('button', { name: 'Free', exact: true }).click();
  await expect(admission).toHaveValue('Free');
  await expect(save).toBeEnabled();

  await admission.fill('7.5');
  await save.click();
  await expect(dialog).toBeHidden();

  const { templates } = (await (await page.request.get('/api/tournament-templates')).json()) as {
    templates: { name: string; registration: { admissionCents?: number | null } }[];
  };
  expect(templates.find((t) => t.name === 'Priced Cup')?.registration.admissionCents).toBe(750);
});
