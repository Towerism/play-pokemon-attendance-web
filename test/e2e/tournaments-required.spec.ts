import type { RequiredEventsCoverage } from '../../server/modules/tournaments/required-events';
import { badgeCount, periodLabel, requirementLabel } from '../../app/utils/tournaments';
import { expect, test } from './fixtures';

// The required-events badge on the nav and the grid on Tournaments (ADR-0010 decision 12, #98). The seeded six
// requirements and an empty play-tools leave many cells needing attention; the count is read over the API rather
// than assumed, since it moves with the calendar. Last month's TCG League Challenge cell always counts: its latest
// date is behind us, so it is in its last chance or missed.

test('the nav badge counts what needs attention, and Mark as covered… brings it down at once', async ({ page, connected }) => {
  const coverage = (await (await connected.request('/api/tournaments/requirements')).json()) as RequiredEventsCoverage;
  const count = badgeCount(coverage);
  expect(count).toBeGreaterThan(0);
  const challenge = coverage.requirements.find((r) => r.requirement.seriesMatch === 'League Challenge' && r.requirement.product === 'tcg')!;
  const lastMonth = challenge.periods[0]!;
  expect(['last_chance', 'missed']).toContain(lastMonth.urgency);
  const cell = `${requirementLabel(challenge.requirement)} · ${periodLabel(lastMonth, 'month')}`;

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
