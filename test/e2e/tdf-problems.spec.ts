import { TUESDAY, expect, fixtureFile, test } from './fixtures';

// Bad tournament files never import, invalid rows are shown and skipped, and a
// file from another day is flagged before it lands on the wrong date.

test('TDF problems are shown to the organizer, and only valid players are imported', async ({ page, connected }) => {
  void connected;
  await page.goto(`/?date=${TUESDAY}`);
  const fileInput = page.locator('input[type="file"]');
  const sessionTable = page.getByRole('table').first();
  const playerRows = sessionTable.getByRole('row').filter({ has: page.getByRole('cell') }).filter({ hasText: /\d{7}/ });

  // Not a tournament: an error, no preview, nothing imported.
  await fileInput.setInputFiles(fixtureFile('not-a-tournament.tdf'));
  await expect(page.getByText('This is not a tournament file (.tdf).').first()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(sessionTable.getByText('No session players yet.', { exact: false })).toBeVisible();

  // An invalid ID row is listed with its reason and skipped; the valid players import.
  await fileInput.setInputFiles(fixtureFile('with-invalid.tdf'));
  const preview = page.getByRole('dialog', { name: 'Tuesday League Night' });
  await expect(preview.getByText('Skipped rows')).toBeVisible();
  await expect(preview.getByRole('listitem').filter({ hasText: 'Ivy Invalid' })).toBeVisible();
  await expect(preview.getByText(/1 invalid row skipped/)).toBeVisible();
  await preview.getByRole('button', { name: 'Import' }).click();
  await expect(preview).toBeHidden();
  await expect(playerRows).toHaveCount(2);
  await expect(playerRows.filter({ hasText: '5100001' })).toHaveCount(1);
  await expect(playerRows.filter({ hasText: '5100002' })).toHaveCount(1);

  // A file from another day is flagged before import.
  await fileInput.setInputFiles(fixtureFile('other-date.tdf'));
  const later = page.getByRole('dialog', { name: 'Next Tuesday' });
  await expect(later.getByText(`This tournament was held on 2026-10-20, but you are importing it into ${TUESDAY}.`)).toBeVisible();
  await later.getByRole('button', { name: 'Cancel' }).click();
  await expect(playerRows).toHaveCount(2);
});
