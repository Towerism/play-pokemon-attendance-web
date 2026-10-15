import { dayLabel } from '../../app/utils/tournaments';
import { expect, expectNoHorizontalScroll, leagueDay, plannedTournament, test, tournamentTemplate } from './fixtures';

// Creating tournaments in play-tools from Upcoming (ADR-0010 decisions 5–7, #98). Nothing reaches play-tools before
// the confirm in a dialog that lists what it creates; short notice is acknowledged only by **Create anyway**; a
// refusal shows support details the organizer can copy for Pokémon support.

const creates = (fake: { requests: { method: string; path: string }[] }) => fake.requests.filter((r) => r.method === 'POST' && r.path === '/services/core/tournament');

test('a new tournament 3 days ahead is created only after Create anyway, and the job is followed to the end', async ({ page, connected, fake }) => {
  await tournamentTemplate(connected);
  const date = leagueDay(3);
  const entryName = `Friday Cup · ${dayLabel(date)}`;

  await page.goto('/tournaments');
  await page.getByRole('button', { name: 'New tournament' }).click();
  const plan = page.getByRole('dialog', { name: 'New tournament' });
  await plan.getByRole('combobox', { name: 'Template' }).click();
  await page.getByRole('option', { name: 'Friday Cup' }).click();
  await plan.getByLabel('Date').fill(date);
  await plan.getByRole('button', { name: 'Plan tournament' }).click();
  await expect(plan).toBeHidden();

  const entry = page.getByRole('listitem', { name: entryName });
  await expect(entry).toContainText('Planned');
  await expect(entry).toContainText('Short notice');
  await entry.getByRole('checkbox', { name: `Select ${entryName}` }).check();
  await page.getByRole('button', { name: 'Create 1 in play-tools' }).click();

  const dialog = page.getByRole('dialog', { name: 'Create in play-tools' });
  await expect(dialog.getByText('less than 7 days before it is held')).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(creates(fake)).toEqual([]);
  const started = page.waitForRequest((r) => r.url().endsWith('/api/tournaments/create') && r.method() === 'POST');
  await dialog.getByRole('button', { name: 'Create anyway' }).click();
  expect((await started).postDataJSON()).toMatchObject({ acknowledgeShortNotice: true, retryUnknown: false });

  await expect(dialog.getByText('Done', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Tournaments in this job' })).toContainText('Created');
  expect(creates(fake)).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(entry).toContainText('In play-tools');
});

test('a refused create shows play-tools’ answer and support details to copy', async ({ page, connected, fake, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const template = await tournamentTemplate(connected);
  const date = leagueDay(20);
  await plannedTournament(connected, template.id, date);
  fake.refuseOnce.set('/services/core/tournament', { status: 403, body: { code: 'op.generic.permission_denied', message: 'You do not have permission to perform this action.' } });

  await page.goto('/tournaments');
  const entryName = `Friday Cup · ${dayLabel(date)}`;
  await page.getByRole('button', { name: `Create in play-tools ${entryName}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Create in play-tools' });
  await expect(dialog.getByText('less than 7 days before it is held')).toBeHidden();
  await dialog.getByRole('button', { name: 'Create in play-tools' }).click();

  const items = dialog.getByRole('list', { name: 'Tournaments in this job' });
  await expect(items).toContainText('Refused by play-tools');
  await dialog.getByText('Support details').click();
  const details = dialog.getByRole('region', { name: 'Support details' });
  await expect(details).toContainText('Action: create');
  await expect(details).toContainText('HTTP status: 403');
  await expect(details).toContainText(/Correlation id: fake-\d+/);
  await details.getByRole('button', { name: 'Copy support details' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe((await details.locator('pre').textContent())!.trim());
  expect(copied).not.toMatch(/token|authorization|bearer/i);
});
