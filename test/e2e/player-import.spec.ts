import { fakeRecord, fakeTournament } from '../server/fake-pokemon';
import { STAFF_ID, expect, test } from './fixtures';

// Settings → Player list → Import players from play-tools (#35): the same
// read-only tournament import as the staff import, keeping the players. The
// card follows the job live, then shows what it found, the new players behind
// a disclosure, and the way to History.

const PAT = '6000031';
const QUINN = '6000032';

test('Import players is unavailable until a Pokémon account is connected, and says why', async ({ page, api }) => {
  expect(api).toBeTruthy();
  await page.goto('/settings');

  const card = page.getByRole('region', { name: 'Player list' });
  await expect(card.getByRole('button', { name: 'Import players from play-tools' })).toBeDisabled();
  await expect(card).toContainText('Connect a Pokémon account first.');
});

test('importing players shows progress, then what it found, the new players, and the import in History', async ({ page, connected, fake }) => {
  expect(connected).toBeTruthy();
  fake.tournaments.push(
    fakeTournament('this-league', { startsAt: '2026-10-14T00:30:00Z', organizer: STAFF_ID }),
    fakeTournament('last-month', { startsAt: '2026-09-02T00:30:00Z', organizer: STAFF_ID }),
  );
  fake.tournamentRecords.set('this-league', [
    fakeRecord(STAFF_ID, { role: 'organizer', first: 'Olive', last: 'Organizer' }),
    fakeRecord('6000021', { role: 'judge', first: 'Jo', last: 'Judge' }),
    fakeRecord(PAT, { first: 'Pat', last: 'Player' }),
  ]);
  fake.tournamentRecords.set('last-month', [fakeRecord(STAFF_ID, { role: 'organizer' }), fakeRecord(QUINN, { first: 'Quinn', last: 'Quick' })]);
  // Slow enough to see the job running.
  fake.tournamentReadDelayMs = 400;

  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Player list' });
  const button = card.getByRole('button', { name: 'Import players from play-tools' });
  await expect(button).toBeEnabled();
  await button.click();

  await expect(button).toBeDisabled();
  await expect(card.getByText(/Read [01] of 2 tournaments|Starting…/)).toBeVisible();

  await expect(card).toContainText('Read 2 of 2 tournaments · 2 players found · 2 new players', { timeout: 15_000 });
  await expect(card.getByText('Done')).toBeVisible();
  // The new players wait behind a disclosure.
  const players = card.getByRole('listitem');
  await expect(players.first()).toBeHidden();
  await card.getByText('Show the 2 new players').click();
  await expect(players).toHaveText([`Pat Player · ${PAT}`, `Quinn Quick · ${QUINN}`]);
  await expect(card).not.toContainText('Jo Judge');
  await expect(button).toBeEnabled();

  await card.getByRole('link', { name: 'See it in History' }).click();
  await expect(page).toHaveURL(/\/history\/\d+$/);
  await expect(page.getByText('Read 2 of 2 tournaments · 2 players found · 2 new players')).toBeVisible();
  await expect(page.getByText("A player import can't be undone.")).toBeVisible();

  await page.goto('/history');
  await expect(page.getByRole('row').filter({ hasText: 'Player import' })).toContainText('Done');

  // Players → All lists them now.
  await page.goto('/players?tab=all');
  await expect(page.getByText('Quinn Quick')).toBeVisible();
});

test.describe('on a phone (360 px)', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('the Player list card fits and announces progress and the result in its live region', async ({ page, connected, fake }) => {
    expect(connected).toBeTruthy();
    fake.tournaments.push(fakeTournament('this-league', { startsAt: '2026-10-14T00:30:00Z', organizer: STAFF_ID }));
    fake.tournamentRecords.set('this-league', [
      fakeRecord(STAFF_ID, { role: 'organizer' }),
      fakeRecord(PAT, { first: 'Wolfeschlegelsteinhausenbergerdorffvoralternwarengewissenhaf', last: 'Player' }),
    ]);
    fake.tournamentReadDelayMs = 600;

    await page.goto('/settings');
    const card = page.getByRole('region', { name: 'Player list' });
    const live = card.locator('[aria-live="polite"]');
    await expect(live).toHaveCount(1);

    await card.getByRole('button', { name: 'Import players from play-tools' }).click();
    await expect(live).toContainText(/Read 0 of 1 tournaments|Starting…/);
    await expect(live).toContainText('Read 1 of 1 tournaments · 1 player found · 1 new player', { timeout: 15_000 });
    await card.getByText('Show the 1 new player').click();

    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: window.innerWidth }));
    expect(widths.scroll, 'page scrolls sideways').toBeLessThanOrEqual(widths.client);
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  });
});
