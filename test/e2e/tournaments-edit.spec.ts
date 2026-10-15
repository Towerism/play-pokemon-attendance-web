import { type Api, dayHeading, expect, expectNoHorizontalScroll, leagueDay, test, tournamentTemplate } from './fixtures';

// Edit… across a schedule (ADR-0010 decision 11, #98), on tournaments not created yet: everything stays local. The
// name's carry-over tick starts off, the details' on; an entry unticked in the preview keeps its old details. Skip is
// local too.

interface Entry {
  plannedId: number;
  localDate: string;
  state: string;
}

async function details(api: Api, plannedId: number): Promise<string | null> {
  const form = (await (await api.request(`/api/tournaments/${plannedId}/edit`)).json()) as { values: { details: string | null } };
  return form.values.details;
}

test('a details change goes to this and later planned tournaments, except the one unticked, and nothing reaches play-tools', async ({ page, connected, fake }) => {
  const template = await tournamentTemplate(connected);
  const scaffold = (await (
    await connected.request('/api/tournament-scaffolds', { method: 'POST', json: { name: 'Fridays', slots: [{ templateId: template.id, dayOffset: 0, startTime: null }] } })
  ).json()) as { scaffold: { id: number } };
  const first = leagueDay(10);
  const weekday = ((new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const created = await connected.request('/api/tournament-schedules', {
    method: 'POST',
    json: { scaffoldId: scaffold.scaffold.id, rule: { kind: 'weekly', weekday, every: 1 }, startsOn: first, endsOn: leagueDay(24) },
  });
  expect(created.status).toBe(201);
  const upcoming = (await (await connected.request('/api/tournaments/upcoming')).json()) as { tournaments: Entry[] };
  const rows = upcoming.tournaments.filter((t) => t.state === 'planned');
  expect(rows.map((r) => r.localDate)).toEqual([leagueDay(10), leagueDay(17), leagueDay(24)]);
  fake.requests.length = 0;

  await page.goto('/tournaments');
  const entry = (date: string) => `Friday Cup · ${dayHeading(date)}`;
  await page.getByRole('button', { name: `Edit… ${entry(rows[0]!.localDate)}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit tournament' });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Friday Cup special');
  await dialog.getByRole('textbox', { name: 'Details', exact: true }).fill('Bring a deck box');
  await dialog.getByRole('radio', { name: 'This and later tournaments in the schedule' }).check();
  await expect(dialog.getByRole('checkbox', { name: 'Carry over Name' })).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Carry over Details' })).toBeChecked();
  await expectNoHorizontalScroll(page);
  await dialog.getByRole('button', { name: 'Preview' }).click();

  const planned = dialog.getByRole('list', { name: 'Planned (updated here)' });
  await expect(planned.getByRole('listitem')).toHaveCount(3);
  await expect(planned).toContainText('Bring a deck box');
  await planned.getByRole('checkbox', { name: `Include ${entry(rows[2]!.localDate)}` }).uncheck();
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/tournaments/${rows[0]!.plannedId}/edit`) && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const { updatedLocally } = (await (await saved).json()) as { updatedLocally: number };
  // The toast's title (Nuxt UI repeats it in a hidden live region).
  await expect(page.locator('[data-slot="title"]', { hasText: `Updated ${updatedLocally} planned tournament` })).toBeVisible();

  expect(await details(connected, rows[0]!.plannedId)).toBe('Bring a deck box');
  expect(await details(connected, rows[1]!.plannedId)).toBe('Bring a deck box');
  expect(await details(connected, rows[2]!.plannedId)).toBeNull();

  // Skipping a date is local too.
  const second = page.getByRole('listitem', { name: entry(rows[1]!.localDate) });
  await second.getByRole('button', { name: `Skip ${entry(rows[1]!.localDate)}` }).click();
  await expect(second).toContainText('Skipped');
  await expect(second.getByRole('button', { name: `Unskip ${entry(rows[1]!.localDate)}` })).toBeVisible();

  expect(fake.requests.filter((r) => r.method !== 'GET' && r.path.startsWith('/services/'))).toEqual([]);
});
