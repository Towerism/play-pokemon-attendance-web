import { expect, monthHeading, leagueDay, test, tournamentTemplate } from './fixtures';

// Required events on Tournaments (ADR-0010 decision 12, #98, #162): the grid has its own tab carrying the nav badge's
// count; the other tabs show the compact banner, which links to it. The seeded six requirements and an empty play-tools
// leave many cells needing attention; the count is read over the API rather than assumed, since it moves with the
// calendar. Last month's TCG League Challenge cell always counts: its latest date is behind us, so it is in its last
// chance or missed.

interface Coverage {
  requirements: { requirement: { seriesMatch: string; product: string }; periods: { periodStart: string; urgency: string | null; status: string }[] }[];
}

const LOUD = ['at_risk', 'short_notice', 'last_chance', 'missed'];
const needs = (n: number) => `Required events, ${n} need${n === 1 ? 's' : ''} attention`;

test('the grid has its own tab with the badge’s count, the banner points to it, and Mark as covered… brings both down', async ({ page, connected }) => {
  const coverage = (await (await connected.request('/api/tournaments/requirements')).json()) as Coverage;
  const count = coverage.requirements.flatMap((r) => r.periods).filter((p) => p.urgency !== null && LOUD.includes(p.urgency)).length;
  expect(count).toBeGreaterThan(1);
  const challenge = coverage.requirements.find((r) => r.requirement.seriesMatch === 'League Challenge' && r.requirement.product === 'tcg')!;
  const lastMonth = challenge.periods[0]!;
  expect(['last_chance', 'missed']).toContain(lastMonth.urgency);
  const cell = `League Challenge · TCG · each month · ${monthHeading(lastMonth.periodStart)}`;
  const coverageReads: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/tournaments/requirements') coverageReads.push(r.url());
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Open menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu.getByRole('status', { name: `${count} required events need attention` })).toBeVisible();
  await menu.getByRole('link', { name: 'Tournaments', exact: true }).click();

  // Upcoming: no grid, the banner above the tabs, and the count on the Required events tab.
  await expect(page.getByRole('heading', { name: 'Tournaments', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Upcoming' })).toHaveAttribute('aria-selected', 'true');
  const grid = page.getByRole('region', { name: 'Required events', exact: true });
  await expect(grid).toHaveCount(0);
  const banner = page.getByRole('alert', { name: 'Required events alerts' });
  await expect(banner.getByText(/League Challenge for TCG/).first()).toBeVisible();
  await expect(page.getByRole('tab', { name: needs(count) })).toBeVisible();

  // The banner's link opens the tab: the grid, and no banner.
  await banner.getByRole('link', { name: 'Open Required events' }).click();
  await expect(page).toHaveURL(/\/tournaments\?tab=required$/);
  await expect(page.getByRole('tab', { name: needs(count) })).toHaveAttribute('aria-selected', 'true');
  await expect(grid.getByRole('listitem', { name: cell })).toBeVisible();
  await expect(page.getByRole('alert', { name: 'Required events alerts' })).toHaveCount(0);
  // The layout's read serves the badge, the tab, the banner and the grid alike.
  expect(coverageReads).toHaveLength(1);

  await grid.getByRole('button', { name: `Mark as covered… ${cell}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark as covered' });
  await dialog.getByLabel('Note').fill('Run by Professor X, 0123-4567');
  await dialog.getByRole('button', { name: 'Save cover' }).click();
  await expect(dialog).toBeHidden();

  await expect(grid.getByRole('listitem', { name: cell })).toContainText('Covered (manual)');
  await expect(grid.getByRole('button', { name: `Remove cover ${cell}` })).toBeVisible();
  await expect(page.getByRole('tab', { name: needs(count - 1) })).toBeVisible();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(menu.getByRole('status', { name: `${count - 1} required events need attention` })).toBeVisible();
});

test('Plan one… on the tab opens New tournament with the requirement’s template and date, details changeable', async ({ page, connected }) => {
  await tournamentTemplate(connected, { name: 'League Challenge {month}', type: { kind: 'premier', seriesMatch: 'League Challenge' } });
  const coverage = (await (await connected.request('/api/tournaments/requirements')).json()) as Coverage;
  const challenge = coverage.requirements.find((r) => r.requirement.seriesMatch === 'League Challenge' && r.requirement.product === 'tcg')!;
  const open = challenge.periods.find((p) => p.status === 'missing' && p.periodStart >= leagueDay(0).slice(0, 8) + '01')!;
  const cell = `League Challenge · TCG · each month · ${monthHeading(open.periodStart)}`;

  await page.goto('/tournaments?tab=required');
  await page.getByRole('region', { name: 'Required events', exact: true }).getByRole('button', { name: `Plan one… ${cell}` }).click();

  const plan = page.getByRole('dialog', { name: 'New tournament' });
  await expect(plan.getByRole('combobox', { name: 'Template' })).toContainText('League Challenge {month}');
  await plan.getByRole('button', { name: 'Change from the template' }).click();
  await expect(plan.getByRole('textbox', { name: 'Name' })).toHaveValue('League Challenge {month}');
  await expect(plan.getByLabel('Game')).toHaveValue('TCG');
  await plan.getByRole('textbox', { name: 'Name' }).fill('Halloween League Challenge');
  await expect(plan.getByText('1 detail differs from the template')).toBeVisible();
  await plan.getByRole('button', { name: 'Reset to template' }).click();
  await expect(plan.getByRole('textbox', { name: 'Name' })).toHaveValue('League Challenge {month}');
  await expect(plan.getByText(/differs? from the template/)).toHaveCount(0);
});
