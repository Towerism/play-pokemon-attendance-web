import type { Locator } from '@playwright/test';
import { fakeRecord, fakeTournament } from '../server/fake-pokemon';
import { STAFF_ID, expect, test } from './fixtures';

// Settings → Staff list → Import staff from play-tools (ADR-0007 decision 5):
// the button waits for a usable connection, the card follows the read-only
// job live, then shows what it found, the new players to check, and the way
// to History. Coming back to Settings shows the latest import again.

const JO = '6000021';
const DEAD_NAME = '6000022';

test('Import staff is unavailable until a Pokémon account is connected, and says why', async ({ page, api }) => {
  expect(api).toBeTruthy();
  await page.goto('/settings');

  const card = page.getByRole('region', { name: 'Staff list' });
  await expect(card.getByRole('button', { name: 'Import staff from play-tools' })).toBeDisabled();
  await expect(card).toContainText('Connect a Pokémon account first.');
});

test('importing staff shows progress, then what it found, and the import in History', async ({ page, connected, fake }) => {
  expect(connected).toBeTruthy();
  fake.tournaments.push(
    fakeTournament('this-league', { startsAt: '2026-10-14T00:30:00Z', organizer: STAFF_ID }),
    fakeTournament('last-month', { startsAt: '2026-09-02T00:30:00Z', organizer: STAFF_ID }),
  );
  fake.tournamentRecords.set('this-league', [
    fakeRecord(STAFF_ID, { role: 'organizer', first: 'Olive', last: 'Organizer' }),
    fakeRecord(JO, { role: 'judge', first: 'Jo', last: 'Judge' }),
    fakeRecord('6000099', { first: 'Pat', last: 'Player' }),
  ]);
  fake.tournamentRecords.set('last-month', [
    fakeRecord(STAFF_ID, { role: 'organizer' }),
    fakeRecord(DEAD_NAME, { role: 'scorekeeper', first: 'Dead', last: 'Name' }),
  ]);
  // Slow enough to see the job running.
  fake.tournamentReadDelayMs = 400;

  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Staff list' });
  const button = card.getByRole('button', { name: 'Import staff from play-tools' });
  await expect(button).toBeEnabled();
  await button.click();

  // Live: the button stays busy and the progress counts tournaments.
  await expect(button).toBeDisabled();
  await expect(card.getByText(/Read [01] of 2 tournaments|Starting…/)).toBeVisible();

  await expect(card).toContainText('Read 2 of 2 tournaments · 2 staff found · 2 new players', { timeout: 15_000 });
  await expect(card.getByText('Done')).toBeVisible();
  await expect(card.getByRole('listitem')).toHaveText([`Dead Name · ${DEAD_NAME}`, `Jo Judge · ${JO}`]);
  await expect(card).not.toContainText('Olive');
  await expect(card).not.toContainText('Pat Player');
  await expect(card.getByRole('link', { name: 'Players → Staff' })).toHaveAttribute('href', '/players?tab=staff');
  await expect(button).toBeEnabled();

  // Coming back to Settings shows the latest import.
  await page.reload();
  await expect(card).toContainText('Read 2 of 2 tournaments · 2 staff found · 2 new players');

  await card.getByRole('link', { name: 'See it in History' }).click();
  await expect(page).toHaveURL(/\/history\/\d+$/);
  await expect(page.getByText('Read 2 of 2 tournaments · 2 staff found · 2 new players')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: JO })).toContainText('New player');
  await expect(page.getByRole('button', { name: /Remove players/ })).toHaveCount(0);
  await expect(page.getByText("A staff import can't be undone.")).toBeVisible();

  await page.goto('/history');
  await expect(page.getByRole('row').filter({ hasText: 'Staff import' })).toContainText('Done');
});

test.describe('on a phone (360 px)', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  // One unbroken 60-character word: it must wrap inside the card, not widen the page.
  const LONG_NAME = 'Wolfeschlegelsteinhausenbergerdorffvoralternwarengewissenhaf';

  /** The page never scrolls sideways, and the card sits fully between the screen's edges. */
  async function expectFitsScreen(card: Locator): Promise<void> {
    const page = card.page();
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: window.innerWidth }));
    expect(widths.scroll, 'page scrolls sideways').toBeLessThanOrEqual(widths.client);
    const box = (await card.boundingBox())!;
    expect(box.x, 'card starts off the left edge').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'card runs off the right edge').toBeLessThanOrEqual(page.viewportSize()!.width);
  }

  test('the Staff list card fits, announces progress and the result as text, with a named button', async ({ page, connected, fake }) => {
    expect(connected).toBeTruthy();
    fake.tournaments.push(fakeTournament('this-league', { startsAt: '2026-10-14T00:30:00Z', organizer: STAFF_ID }));
    fake.tournamentRecords.set('this-league', [
      fakeRecord(STAFF_ID, { role: 'organizer' }),
      fakeRecord(JO, { role: 'judge', first: LONG_NAME, last: 'Judge' }),
    ]);
    fake.tournamentReadDelayMs = 600;

    await page.goto('/settings');
    const card = page.getByRole('region', { name: 'Staff list' });
    const live = card.locator('[aria-live="polite"]');
    await expect(live).toHaveCount(1);
    const button = card.getByRole('button', { name: 'Import staff from play-tools' });
    await expectFitsScreen(card);

    await button.click();
    // While it runs, the progress is text inside the live region.
    await expect(live).toContainText(/Read 0 of 1 tournaments|Starting…/);
    await expectFitsScreen(card);

    // The result is text too, not only a colour, and still in the live region.
    await expect(live).toContainText('Read 1 of 1 tournaments · 1 staff found · 1 new player', { timeout: 15_000 });
    await expect(live).toContainText('Done');
    await expect(live.getByRole('listitem')).toHaveText(`${LONG_NAME} Judge · ${JO}`);
    await expectFitsScreen(card);
    const item = (await live.getByRole('listitem').boundingBox())!;
    expect(item.x + item.width, 'new player runs off the right edge').toBeLessThanOrEqual(360);
  });
});
