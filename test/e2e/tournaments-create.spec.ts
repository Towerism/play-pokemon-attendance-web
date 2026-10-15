import { dayHeading, expect, expectNoHorizontalScroll, leagueDay, plannedTournament, test, tournamentTemplate } from './fixtures';

// Creating tournaments in play-tools from Upcoming (ADR-0010 decisions 5–7, #98). Nothing reaches play-tools before
// the confirm in a dialog that lists what it creates; short notice is acknowledged only by **Create anyway**; a
// refusal shows support details the organizer can copy for Pokémon support.

const creates = (fake: { requests: { method: string; path: string }[] }) => fake.requests.filter((r) => r.method === 'POST' && r.path === '/services/core/tournament');

test('a new tournament 3 days ahead is created only after Create anyway, and the job is followed to the end', async ({ page, connected, fake }) => {
  await tournamentTemplate(connected);
  const date = leagueDay(3);
  const entryName = `Friday Cup · ${dayHeading(date)}`;

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
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(entry).toContainText('In play-tools');
});

test('a refused create shows play-tools’ answer and support details to copy', async ({ page, connected, fake, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const template = await tournamentTemplate(connected);
  const date = leagueDay(20);
  await plannedTournament(connected, template.id, date);
  fake.refuseOnce.set('/services/core/tournament', { status: 403, body: { code: 'op.generic.permission_denied', message: 'You do not have permission to perform this action.' } });

  await page.goto('/tournaments');
  const entryName = `Friday Cup · ${dayHeading(date)}`;
  await page.getByRole('button', { name: `Create in play-tools ${entryName}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Create in play-tools' });
  await expect(dialog.getByText('less than 7 days before it is held')).toBeHidden();
  await dialog.getByRole('button', { name: 'Create in play-tools' }).click();

  const items = dialog.getByRole('list', { name: 'Tournaments in this job' });
  await expect(items).toContainText('Refused by play-tools');
  await dialog.locator('summary', { hasText: 'Support details' }).click();
  const details = dialog.getByRole('region', { name: 'Support details' });
  await expect(details).toContainText('Action: create');
  await expect(details).toContainText('HTTP status: 403');
  await expect(details).toContainText(/Correlation id: fake-\d+/);
  await details.getByRole('button', { name: 'Copy support details' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe((await details.locator('pre').textContent())!.trim());
  expect(copied).not.toMatch(/token|authorization|bearer/i);
});

// #162: a one-off from a template with its details changed. A premier League Challenge template planned as a Custom
// "Halloween Cup" reaches play-tools as that, while the same template left as it is goes in its series.
test('a League Challenge template planned as a Custom tournament with its own name is created as one', async ({ page, connected, fake }) => {
  const date = leagueDay(10);
  fake.series.push({
    guid: 'lc-e2e',
    name: 'League Challenge E2E',
    product: 'tcg',
    category_slugs: ['tcg_std'],
    tags: [],
    play_template: null,
    schedule: { US: { start_date: leagueDay(-5), end_date: leagueDay(40) } },
  });
  await tournamentTemplate(connected, { name: 'League Challenge {month}', type: { kind: 'premier', seriesMatch: 'League Challenge' } });
  const templateId = ((await (await connected.request('/api/tournament-templates')).json()) as { templates: { id: number }[] }).templates[0]!.id;
  // The control: the same template on the same date, as it is, by the API.
  const control = await connected.request('/api/planned-tournaments', { method: 'POST', json: { templateId, localDate: date, startTime: '12:00' } });
  expect(control.status).toBe(201);
  const month = new Date(`${date}T12:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/tournaments');
  await page.getByRole('button', { name: 'New tournament' }).click();
  const plan = page.getByRole('dialog', { name: 'New tournament' });
  await plan.getByRole('combobox', { name: 'Template' }).click();
  await page.getByRole('option', { name: 'League Challenge {month}' }).click();
  await plan.getByLabel('Date').fill(date);
  const details = plan.getByRole('button', { name: 'Change from the template' });
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  await expect(plan.getByLabel('Organizer')).toBeDisabled();
  await plan.getByRole('textbox', { name: 'Name' }).fill('Halloween Cup');
  await plan.getByRole('combobox', { name: 'Type' }).click();
  await page.getByRole('option', { name: 'Custom', exact: true }).click();
  await expect(plan.getByText('2 details differ from the template')).toBeVisible();
  await expectNoHorizontalScroll(page);
  const planned = page.waitForRequest((r) => r.url().endsWith('/api/planned-tournaments') && r.method() === 'POST');
  await plan.getByRole('button', { name: 'Plan tournament' }).click();
  expect((await planned).postDataJSON()).toEqual({ templateId, localDate: date, overrides: { name: 'Halloween Cup' }, seriesId: 'custom' });
  await expect(plan).toBeHidden();

  const halloween = page.getByRole('listitem', { name: `Halloween Cup · ${dayHeading(date)}` });
  const asItIs = page.getByRole('listitem', { name: `League Challenge ${month} · ${dayHeading(date)}` });
  await expect(halloween).toContainText('Planned');
  await halloween.getByRole('checkbox', { name: `Select Halloween Cup · ${dayHeading(date)}` }).check();
  await asItIs.getByRole('checkbox', { name: `Select League Challenge ${month} · ${dayHeading(date)}` }).check();
  await page.getByRole('button', { name: 'Create 2 in play-tools' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create in play-tools' });
  await dialog.getByRole('button', { name: 'Create in play-tools' }).click();
  await expect(dialog.getByText('Done', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(halloween).toContainText('In play-tools');

  const sent = creates(fake).map((r) => (r as { body?: { name: string; series_guid: string | null } }).body!);
  expect(sent.map((b) => [b.name, b.series_guid]).sort()).toEqual([
    ['Halloween Cup', null],
    [`League Challenge ${month}`, 'lc-e2e'],
  ]);
  await expectNoHorizontalScroll(page);
});
