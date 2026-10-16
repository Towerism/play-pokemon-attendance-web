import type { Page, Route } from '@playwright/test';
import { dayHeading, expect, leagueDay, plannedTournament, test, tournamentTemplate } from './fixtures';

// Tournaments shows at once and fills in as each read answers (#191). Every read here is held by a gate the test
// opens itself, so what shows first is chosen by the test, never by how fast the server is; "not blocked" means
// "shown while the gate is still shut".

/** A read held until `release()`, or answered with a failure by `fail()`. `hold()` shuts it again for the next request. */
interface Gate {
  release(): void;
  fail(status?: number): void;
  hold(): void;
}

async function gate(page: Page, url: string | RegExp): Promise<Gate> {
  let open!: (how: 'through' | number) => void;
  let decided = new Promise<'through' | number>((resolve) => (open = resolve));
  await page.route(url, async (route: Route) => {
    const how = await decided;
    if (how === 'through') await route.continue();
    else await route.fulfill({ status: how, json: { statusCode: how, message: 'Held read failed' } });
  });
  return {
    release: () => open('through'),
    fail: (status = 500) => open(status),
    hold: () => {
      decided = new Promise((resolve) => (open = resolve));
    },
  };
}

/** Gates for every read the Tournaments page makes. */
async function tournamentsGates(page: Page) {
  return {
    settings: await gate(page, '**/api/settings'),
    coverage: await gate(page, '**/api/tournaments/requirements*'),
    upcoming: await gate(page, '**/api/tournaments/upcoming*'),
    templates: await gate(page, /\/api\/tournament-templates(\?|$)/),
    scaffolds: await gate(page, '**/api/tournament-scaffolds'),
    schedules: await gate(page, '**/api/tournament-schedules'),
  };
}
type Gates = Awaited<ReturnType<typeof tournamentsGates>>;
const releaseAll = (g: Gates) => Object.values(g).forEach((x) => x.release());

const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const checking = (page: Page) => page.getByRole('status').filter({ hasText: 'Checking required events…' });

test('opening Tournaments shows the page at once, starts every read together, and fills each part as it answers', async ({ page, connected }) => {
  const template = await tournamentTemplate(connected);
  const requested: string[] = [];
  page.on('request', (r) => requested.push(new URL(r.url()).pathname));
  const g = await tournamentsGates(page);
  try {
    // The layout's required-events read starts on Regulars and is held there too.
    await page.goto('/regulars');
    await expect(page.getByRole('heading', { name: 'Regulars' })).toBeVisible();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Tournaments', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Tournaments', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Upcoming' })).toHaveAttribute('aria-selected', 'true');
    const upcoming = section(page, 'Upcoming');
    await expect(upcoming).toHaveAttribute('aria-busy', 'true');
    await expect(upcoming.getByText('Loading Upcoming…')).toBeAttached();
    await expect(upcoming.getByRole('button', { name: 'Refresh upcoming' })).toBeEnabled();
    await expect(upcoming.getByRole('button', { name: 'New tournament' })).toBeDisabled();
    await expect(checking(page)).toBeVisible();
    // Nothing waits for anything else: all three reads are out while every gate is still shut.
    await expect.poll(() => ['/api/settings', '/api/tournaments/requirements', '/api/tournaments/upcoming'].filter((p) => !requested.includes(p))).toEqual([]);

    // The league clock answers: New tournament can open.
    g.settings.release();
    await expect(upcoming.getByRole('button', { name: 'New tournament' })).toBeEnabled();

    // Templates switches at once and shows what it is waiting for.
    await page.getByRole('tab', { name: 'Templates' }).click();
    const templates = section(page, 'Templates');
    await expect(templates).toHaveAttribute('aria-busy', 'true');
    await expect(templates.getByText('Loading Templates…')).toBeAttached();
    await expect(templates.getByRole('switch', { name: 'Show archived' })).toBeEnabled();
    await expect(templates.getByRole('button', { name: 'New template' })).toBeEnabled();
    g.templates.release();
    await expect(templates.getByRole('listitem', { name: template.name })).toBeVisible();
    await expect(templates).not.toHaveAttribute('aria-busy', 'true');

    // Coverage answers: the spinner line goes and the banner shows what is at risk.
    await expect(checking(page)).toBeVisible();
    g.coverage.release();
    await expect(page.getByRole('alert', { name: 'Required events alerts' })).toBeVisible();
    await expect(checking(page)).toHaveCount(0);

    g.upcoming.release();
    await page.getByRole('tab', { name: 'Upcoming' }).click();
    await expect(upcoming.getByText('Nothing planned or in play-tools yet.')).toBeVisible();
    await expect(upcoming).not.toHaveAttribute('aria-busy', 'true');
  } finally {
    releaseAll(g);
  }
});

test('Upcoming shows before required events, and Refresh keeps its rows on screen', async ({ page, connected }) => {
  const template = await tournamentTemplate(connected);
  const date = leagueDay(10);
  await plannedTournament(connected, template.id, date);
  const row = page.getByRole('listitem', { name: `${template.name} · ${dayHeading(date)}` });
  const coverage = await gate(page, '**/api/tournaments/requirements*');
  const upcoming = await gate(page, '**/api/tournaments/upcoming*');
  try {
    await page.goto('/tournaments');
    await expect(section(page, 'Upcoming')).toHaveAttribute('aria-busy', 'true');

    upcoming.release();
    await expect(row).toBeVisible();
    await expect(checking(page)).toBeVisible();

    upcoming.hold();
    const refresh = page.getByRole('button', { name: 'Refresh upcoming' });
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await expect(row).toBeVisible();
    await expect(section(page, 'Upcoming')).not.toHaveAttribute('aria-busy', 'true');
    upcoming.release();
    await expect(refresh).toBeEnabled();
    await expect(row).toBeVisible();
  } finally {
    coverage.release();
    upcoming.release();
  }
});

test('a failed required-events read shows only above the tabs; the rest of the page loads', async ({ page, connected }) => {
  const template = await tournamentTemplate(connected);
  const coverage = await gate(page, '**/api/tournaments/requirements*');
  coverage.fail(500);

  await page.goto('/tournaments');
  const alerts = page.getByRole('alert', { name: 'Required events alerts' });
  const failed = alerts.getByText('Could not check required events.');
  await expect(failed).toBeVisible();
  await expect(checking(page)).toHaveCount(0);
  await expect(section(page, 'Upcoming').getByText('Nothing planned or in play-tools yet.')).toBeVisible();
  await page.getByRole('tab', { name: 'Templates' }).click();
  await expect(section(page, 'Templates').getByRole('listitem', { name: template.name })).toBeVisible();
  await page.getByRole('tab', { name: 'Schedules' }).click();
  await expect(section(page, 'Schedules')).not.toHaveAttribute('aria-busy', 'true');

  // Try again reads it afresh.
  await page.unroute('**/api/tournaments/requirements*');
  await alerts.getByRole('button', { name: 'Try again' }).click();
  await expect(failed).toHaveCount(0);
  await expect(alerts.getByText(/League Challenge for TCG/).first()).toBeVisible();
});

test("a failed league clock read stops only what needs the clock, and Try again recovers", async ({ page, connected }) => {
  const template = await tournamentTemplate(connected);
  const settings = await gate(page, '**/api/settings');
  settings.fail(500);

  await page.goto('/tournaments');
  const upcoming = section(page, 'Upcoming');
  await expect(upcoming.getByText("Could not read the league's time zone.")).toBeVisible();
  await page.getByRole('tab', { name: 'Templates' }).click();
  await expect(section(page, 'Templates').getByRole('listitem', { name: template.name })).toBeVisible();
  await expect(section(page, 'Templates').getByRole('button', { name: 'New template' })).toBeDisabled();

  await page.unroute('**/api/settings');
  await page.getByRole('tab', { name: 'Upcoming' }).click();
  await upcoming.getByRole('button', { name: 'Try again' }).click();
  await expect(upcoming.getByText('Nothing planned or in play-tools yet.')).toBeVisible();
  await expect(upcoming.getByRole('button', { name: 'New tournament' })).toBeEnabled();
});

test('opening Required events directly shows its grid loading, with its buttons usable', async ({ page, connected: _connected }) => {
  const coverage = await gate(page, '**/api/tournaments/requirements*');
  try {
    await page.goto('/tournaments?tab=required');
    const grid = section(page, 'Required events');
    await expect(grid).toHaveAttribute('aria-busy', 'true');
    await expect(grid.getByText('Loading Required events…')).toBeAttached();
    await expect(grid.getByRole('button', { name: 'Requirements…' })).toBeEnabled();
    await expect(grid.getByRole('button', { name: 'Refresh required events' })).toBeEnabled();
    coverage.release();
    await expect(grid).not.toHaveAttribute('aria-busy', 'true');
  } finally {
    coverage.release();
  }
});

test('a change still says it worked when the read after it fails', async ({ page, connected }) => {
  const template = await tournamentTemplate(connected);
  const date = leagueDay(10);
  await plannedTournament(connected, template.id, date);
  const name = `${template.name} · ${dayHeading(date)}`;

  await page.goto('/tournaments');
  const row = page.getByRole('listitem', { name });
  await expect(row).toBeVisible();
  const coverage = await gate(page, '**/api/tournaments/requirements*');
  coverage.fail(500);

  await row.getByRole('button', { name: `Skip ${name}` }).click();
  await expect(page.getByText(`Skipped ${name}`, { exact: true })).toBeVisible();
  await expect(page.getByText('Could not change the tournament.')).toHaveCount(0);
  await expect(row.getByRole('button', { name: `Unskip ${name}` })).toBeVisible();
});
