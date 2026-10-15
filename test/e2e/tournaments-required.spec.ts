import { expect, monthHeading, test } from './fixtures';

// The required-events badge on the nav and the grid on Tournaments (ADR-0010 decision 12, #98). The seeded six
// requirements and an empty play-tools leave many cells needing attention; the count is read over the API rather
// than assumed, since it moves with the calendar. Last month's TCG League Challenge cell always counts: its latest
// date is behind us, so it is in its last chance or missed.

interface Coverage {
  requirements: { requirement: { seriesMatch: string; product: string }; periods: { periodStart: string; urgency: string | null }[] }[];
}

const LOUD = ['at_risk', 'short_notice', 'last_chance', 'missed'];

test('the nav badge counts what needs attention, and Mark as covered… brings it down at once', async ({ page, connected }) => {
  const coverage = (await (await connected.request('/api/tournaments/requirements')).json()) as Coverage;
  const count = coverage.requirements.flatMap((r) => r.periods).filter((p) => p.urgency !== null && LOUD.includes(p.urgency)).length;
  expect(count).toBeGreaterThan(0);
  const challenge = coverage.requirements.find((r) => r.requirement.seriesMatch === 'League Challenge' && r.requirement.product === 'tcg')!;
  const lastMonth = challenge.periods[0]!;
  expect(['last_chance', 'missed']).toContain(lastMonth.urgency);
  const cell = `League Challenge · TCG · each month · ${monthHeading(lastMonth.periodStart)}`;

  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu.getByRole('status', { name: `${count} required events need attention` })).toBeVisible();
  await menu.getByRole('link', { name: 'Tournaments', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Tournaments', level: 1 })).toBeVisible();
  const grid = page.getByRole('region', { name: 'Required events' });
  await grid.getByRole('button', { name: `Mark as covered… ${cell}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark as covered' });
  await dialog.getByLabel('Note').fill('Run by Professor X, 0123-4567');
  await dialog.getByRole('button', { name: 'Save cover' }).click();
  await expect(dialog).toBeHidden();

  await expect(grid.getByRole('listitem', { name: cell })).toContainText('Covered (manual)');
  await expect(grid.getByRole('button', { name: `Remove cover ${cell}` })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(menu.getByRole('status', { name: `${count - 1} required events need attention` })).toBeVisible();
});
