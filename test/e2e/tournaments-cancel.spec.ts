import { fakeRecord, fakeTournament } from '../server/fake-pokemon';
import { STAFF_ID, dayHeading, expect, leagueDay, test } from './fixtures';

// Cancel… (ADR-0010 decision 8, #94, #98): with anyone registered, the organizer types the display id before the
// confirm is enabled; then the job is followed like Submit.

test('a tournament with a registered player is cancelled only after its display id is typed', async ({ page, connected: _connected, fake }) => {
  const date = leagueDay(5);
  const guid = '00000000-0000-4000-8000-0000000000c1';
  fake.tournaments.push(fakeTournament(guid, { startsAt: `${date}T23:00:00Z`, organizer: STAFF_ID, name: 'Saturday Cup', displayId: '26-10-sat-cup' }));
  fake.tournamentRecords.set(guid, [fakeRecord(STAFF_ID, { role: 'organizer' }), fakeRecord('00123', { first: 'Ash', last: 'Ketchum' })]);
  const entryName = `Saturday Cup · ${dayHeading(date)}`;

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
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // play-tools no longer lists a cancelled tournament, and no planned row holds this one, so it leaves Upcoming.
  await expect(page.getByRole('listitem', { name: entryName })).toHaveCount(0);
});
