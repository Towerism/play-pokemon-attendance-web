import { fakeRecord, fakeTournament } from '../server/fake-pokemon';
import { dayLabel } from '../../app/utils/tournaments';
import { STAFF_ID, expect, leagueDay, test } from './fixtures';

// Cancel… (ADR-0010 decision 8, #94, #98): with anyone registered, the organizer types the display id before the
// confirm is enabled; then the job is followed like Submit.

test('a tournament with a registered player is cancelled only after its display id is typed', async ({ page, connected: _connected, fake }) => {
  const date = leagueDay(5);
  fake.tournaments.push(fakeTournament('sat-cup', { startsAt: `${date}T23:00:00Z`, organizer: STAFF_ID, name: 'Saturday Cup' }));
  fake.tournamentRecords.set('sat-cup', [fakeRecord(STAFF_ID, { role: 'organizer' }), fakeRecord('00123', { first: 'Ash', last: 'Ketchum' })]);
  const entryName = `Saturday Cup · ${dayLabel(date)}`;

  await page.goto('/tournaments');
  await page.getByRole('button', { name: `Cancel… ${entryName}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel tournament' });
  await expect(dialog).toContainText('1 player');
  const confirm = dialog.getByRole('button', { name: 'Cancel tournament' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Type 26-10-sat-cup to confirm').fill('26-10-sat-');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Type 26-10-sat-cup to confirm').fill('26-10-sat-cup');
  await confirm.click();

  await expect(dialog.getByText('Done', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Tournaments in this job' })).toContainText('Cancelled');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('listitem', { name: entryName })).toContainText('Cancelled');
});
