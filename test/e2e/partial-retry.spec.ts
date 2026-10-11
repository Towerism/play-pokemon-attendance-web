import { fakeRecord } from '../server/fake-pokemon';
import { STAFF_ID, TUESDAY, addSessionPlayer, expect, playSession, test } from './fixtures';

// A player play-tools didn't keep must never look like success: the dialog
// names them, History puts them first, and Retry sends only them. Progress is
// followed with the live stream blocked, so the polling fallback has to work.

const A = '6000001';
const B = '6000002';

test('a partial submission names who failed, and Retry sends only them', async ({ page, fake, connected }) => {
  fake.playSessions = [playSession('ps-tuesday', '2026-10-13T23:00:00Z')];
  fake.records = new Map([['ps-tuesday', [fakeRecord(STAFF_ID, { role: 'organizer' })]]]);
  await addSessionPlayer(connected, TUESDAY, A, 'Abe Able');
  await addSessionPlayer(connected, TUESDAY, B, 'Bea Bravo');
  fake.dropOnce = new Set([B]);

  let streamsBlocked = 0;
  await page.route('**/api/submissions/*/events', (route) => {
    streamsBlocked += 1;
    return route.abort();
  });

  // One session that day: it is preselected.
  await page.goto(`/?date=${TUESDAY}`);
  await page.getByRole('button', { name: 'Submit attendance' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit attendance' });
  await expect(dialog.getByRole('radio')).toBeChecked();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();

  await expect(dialog.getByText('Partly done', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^1 added · 1 failed/)).toBeVisible();
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Bea Bravo' })).toBeVisible();
  expect(streamsBlocked, 'the live stream was tried, and the dialog finished by polling').toBeGreaterThan(0);

  // History: the failure comes first.
  await dialog.getByRole('link', { name: 'Details' }).click();
  await expect(page).toHaveURL(/\/history\/\d+$/);
  const firstId = page.url().split('/').at(-1)!;
  const firstItem = page.getByRole('row').filter({ has: page.getByRole('cell') }).first();
  await expect(firstItem).toContainText('Bea Bravo');
  await expect(firstItem).toContainText('Failed');

  // Retry: a linked new attempt that sends exactly the missing player.
  const bulksBefore = fake.requests.filter((r) => r.path.endsWith('/_bulk/')).length;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page).not.toHaveURL(new RegExp(`/history/${firstId}$`));
  await expect(page.getByRole('link', { name: `#${firstId}` })).toBeVisible();
  await expect(page.getByText('Done', { exact: true })).toBeVisible();

  const retryBulks = fake.requests.filter((r) => r.path.endsWith('/_bulk/')).slice(bulksBefore);
  expect(retryBulks.map((r) => r.playerIds)).toEqual([[B]]);
  expect((fake.records.get('ps-tuesday') ?? []).map((r) => r.participant.player_id).sort()).toEqual([A, B, STAFF_ID].sort());
});
