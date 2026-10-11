import { fakeRecord } from '../server/fake-pokemon';
import { STAFF_ID, TUESDAY, expect, fixtureFile, playSession, test } from './fixtures';

// The weekly flow (architecture §6.1) on a date with two play sessions:
// what reaches play-tools is regulars ∪ session players, once each, on the
// session the organizer picked, and the UI reports what really happened.

const R1 = '5000001'; // a regular, who is also in the tournament file
const P_UP = '5000002'; // in the file, and already recorded in play-tools
const T1 = '5000003';
const T2 = '0500004'; // leading zero
const M1 = '5000005'; // added by hand

test('weekly flow: regulars and session players land once, on the session the organizer picks', async ({ page, fake, connected }) => {
  void connected;
  fake.playSessions = [playSession('ps-afternoon', '2026-10-13T19:00:00Z'), playSession('ps-evening', '2026-10-13T23:00:00Z')];
  fake.records = new Map([['ps-evening', [fakeRecord(STAFF_ID, { role: 'organizer' }), fakeRecord(P_UP, { first: 'Uma', last: 'Upstream' })]]]);

  // A regular, from the Regulars page.
  await page.goto('/regulars');
  await page.getByPlaceholder('Player ID').fill(R1);
  await page.getByPlaceholder('Name (optional)').fill('Rae Regular');
  await page.getByRole('button', { name: 'Add regular' }).click();
  await expect(page.getByRole('row').filter({ hasText: R1 })).toBeVisible();

  // A walk-in, by hand on This week.
  await page.goto(`/?date=${TUESDAY}`);
  await page.getByPlaceholder('Player ID').fill(M1);
  await page.getByPlaceholder('Name (optional)').fill('Max Manual');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const sessionTable = page.getByRole('table').first();
  await expect(sessionTable.getByRole('row').filter({ hasText: M1 })).toBeVisible();

  // The tournament file: the regular is recognised as one, not added as a session player.
  await page.locator('input[type="file"]').setInputFiles(fixtureFile('weekly.tdf'));
  const preview = page.getByRole('dialog', { name: 'Tuesday League Night' });
  await expect(preview.getByText('3 new · 1 regular')).toBeVisible();
  await preview.getByRole('button', { name: 'Import' }).click();
  await expect(preview).toBeHidden();
  for (const id of [M1, P_UP, T1, T2]) await expect(sessionTable.getByRole('row').filter({ hasText: id })).toBeVisible();
  await expect(sessionTable.getByRole('row').filter({ hasText: R1 })).toHaveCount(0);

  // Two sessions that day: nothing is preselected, so nothing can be sent by accident.
  await page.getByRole('button', { name: 'Submit attendance' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit attendance' });
  const radios = dialog.getByRole('radio');
  await expect(radios).toHaveCount(2);
  for (const radio of await radios.all()) await expect(radio).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();

  await dialog.getByRole('radio', { name: /6:00/ }).check();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog.getByText('Done', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^4 added · 1 already in play-tools/)).toBeVisible();

  // play-tools: exactly the right people, on the right session, in one batch, no duplicates.
  const ids = (session: string) => (fake.records.get(session) ?? []).map((r) => r.participant.player_id).sort();
  expect(ids('ps-evening')).toEqual([STAFF_ID, P_UP, R1, M1, T1, T2].sort());
  expect(ids('ps-afternoon')).toEqual([]);
  const bulks = fake.requests.filter((r) => r.path.endsWith('/_bulk/'));
  expect(bulks).toHaveLength(1);
  expect([...bulks[0]!.playerIds!].sort()).toEqual([R1, M1, T1, T2].sort());

  // History tells the same story, leading zero and all.
  await page.goto('/history');
  const row = page.getByRole('row').filter({ hasText: TUESDAY });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Done', { exact: true })).toBeVisible();
  await row.getByRole('link', { name: TUESDAY }).click();
  await expect(page.getByRole('row').filter({ hasText: T2 }).getByText('Theo Zero')).toBeVisible();
});
