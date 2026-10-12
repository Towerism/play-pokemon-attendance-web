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
    fakeTournament('other-store', { startsAt: '2026-09-02T00:30:00Z', groupId: 'another-store', organizer: STAFF_ID }),
  );
  fake.tournamentRecords.set('this-league', [
    fakeRecord(STAFF_ID, { role: 'organizer', first: 'Olive', last: 'Organizer' }),
    fakeRecord(JO, { role: 'judge', first: 'Jo', last: 'Judge' }),
    fakeRecord('6000099', { first: 'Pat', last: 'Player' }),
  ]);
  fake.tournamentRecords.set('other-store', [
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
