import type { Page, Request } from '@playwright/test';
import { fakeRecord, fakeTournament } from '../server/fake-pokemon';
import { type Api, STAFF_ID, TUESDAY, expect, test } from './fixtures';

// Players → Staff: everyone who has staffed the league's tournaments, with an
// inline rename, since a name seeded from play-tools can be a dead name
// (ADR-0007 decision 13). A rename must stick when play-tools is read again.

const TOURNAMENT = 'tue-cup';
/** Tuesday 19:30 in the league's timezone (America/Chicago). */
const TUESDAY_EVENING = '2026-10-14T00:30:00Z';
const ASH = '6000011';
const BROCK = '6000012';

type Fake = Parameters<Parameters<typeof test>[2]>[0]['fake'];

/** A tournament on Tuesday listing the organizer and the given staff, read once so the app seeds its staff list. */
async function staffTournament(fake: Fake, api: Api, staff: { id: string; role: string; first: string; last: string }[]) {
  fake.tournaments.push(fakeTournament(TOURNAMENT, { startsAt: TUESDAY_EVENING, organizer: STAFF_ID }));
  fake.tournamentRecords.set(TOURNAMENT, [
    fakeRecord(STAFF_ID, { role: 'organizer', first: 'Olive', last: 'Organizer', guid: 'rec-org' }),
    ...staff.map((s) => fakeRecord(s.id, { role: s.role, first: s.first, last: s.last })),
  ]);
  await readTournament(api);
}

/** What the This week Staff card does: read the date's tournaments, which records their staff. */
async function readTournament(api: Api) {
  expect((await api.request(`/api/sessions/${TUESDAY}/staff`)).status).toBe(200);
}

const staffRow = (page: Page, playerId: string) => page.getByRole('row').filter({ hasText: playerId });

test('a rename on the Staff tab sticks when play-tools is read again', async ({ page, connected, fake }) => {
  await staffTournament(fake, connected, [{ id: ASH, role: 'administration', first: 'Old', last: 'Name' }]);
  const playerCalls: string[] = [];
  page.on('request', (r: Request) => {
    if (new URL(r.url()).pathname === '/api/players') playerCalls.push(r.url());
  });

  await page.goto('/players');
  await expect(page.getByRole('tab', { name: 'Promotion candidates' })).toHaveAttribute('aria-selected', 'true');
  playerCalls.length = 0;
  await page.getByRole('tab', { name: 'Staff' }).click();
  await expect(page).toHaveURL(/[?&]tab=staff/);

  const ash = staffRow(page, ASH);
  await expect(ash).toContainText('Old Name');
  await expect(ash).toContainText(TUESDAY);
  await expect(ash).toContainText('Support Staff');
  await expect(ash.getByRole('cell').nth(2)).toHaveText('1');
  // Organizing is not staffing.
  await expect(staffRow(page, STAFF_ID)).toHaveCount(0);

  // Keyboard only: focus Rename, open it, type, save with Enter.
  const rename = page.getByRole('button', { name: 'Rename Old Name' });
  await rename.focus();
  await page.keyboard.press('Enter');
  const input = page.getByRole('textbox', { name: `Name for ${ASH}` });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Old Name');
  await input.fill('New Name');
  const patch = page.waitForRequest((r) => r.method() === 'PATCH');
  await input.press('Enter');
  const sent = await patch;
  expect(new URL(sent.url()).pathname).toBe(`/api/players/${ASH}`);
  expect(sent.postDataJSON()).toEqual({ name: 'New Name' });
  await expect(input).toHaveCount(0);
  await expect(ash).toContainText('New Name');

  // play-tools still says "Old Name"; reading it again must not revert the rename.
  await readTournament(connected);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Staff' })).toHaveAttribute('aria-selected', 'true');
  await expect(staffRow(page, ASH)).toContainText('New Name');
  await expect(staffRow(page, ASH)).not.toContainText('Old Name');

  // The Staff tab never asks for the Players list.
  expect(playerCalls).toEqual([]);
});
