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

test('the rename guards, the staff search, and which tab asks for what', async ({ page, connected, fake }) => {
  await staffTournament(fake, connected, [
    { id: ASH, role: 'judge', first: 'Ash', last: 'Ketchum' },
    { id: BROCK, role: 'scorekeeper', first: 'Brock', last: 'Harrison' },
  ]);
  const calls = { staff: [] as URL[], roles: 0, players: 0, patches: 0 };
  page.on('request', (r: Request) => {
    const url = new URL(r.url());
    if (url.pathname === '/api/staff') calls.staff.push(url);
    if (url.pathname === '/api/staff/roles') calls.roles++;
    if (url.pathname === '/api/players') calls.players++;
    if (r.method() === 'PATCH') calls.patches++;
  });

  await page.goto('/players');
  await expect(page.getByRole('tab', { name: 'Promotion candidates' })).toHaveAttribute('aria-selected', 'true');
  expect(calls.staff).toEqual([]);
  await page.getByRole('tab', { name: 'Staff' }).click();
  await expect(staffRow(page, BROCK)).toContainText('Scorekeeper');
  await expect(staffRow(page, ASH)).toContainText('Judge');
  // Only the threshold tabs link to their thresholds.
  await expect(page.getByRole('link', { name: 'Change thresholds' })).toHaveCount(0);
  await expect(page.getByText('A name from play-tools can be out of date: rename it here.')).toBeVisible();

  const nameBox = (id: string) => page.getByRole('textbox', { name: `Name for ${id}` });

  // Escape cancels without a request.
  await page.getByRole('button', { name: 'Rename Ash Ketchum' }).click();
  await nameBox(ASH).fill('Not this');
  await nameBox(ASH).press('Escape');
  await expect(nameBox(ASH)).toHaveCount(0);
  await expect(staffRow(page, ASH)).toContainText('Ash Ketchum');

  // One row at a time: renaming Brock drops Ash's unsaved text.
  await page.getByRole('button', { name: 'Rename Ash Ketchum' }).click();
  await nameBox(ASH).fill('Unsaved');
  await page.getByRole('button', { name: 'Rename Brock Harrison' }).click();
  await expect(nameBox(ASH)).toHaveCount(0);
  await expect(staffRow(page, ASH)).toContainText('Ash Ketchum');
  await expect(nameBox(BROCK)).toBeVisible();

  // An empty name can't be saved; an unchanged one closes without a request.
  await nameBox(BROCK).fill('   ');
  await expect(staffRow(page, BROCK).getByRole('button', { name: 'Save' })).toBeDisabled();
  await nameBox(BROCK).press('Enter');
  await expect(nameBox(BROCK)).toBeVisible();
  await nameBox(BROCK).fill('Brock Harrison');
  await nameBox(BROCK).press('Enter');
  await expect(nameBox(BROCK)).toHaveCount(0);
  expect(calls.patches).toBe(0);

  // A refused rename says why and keeps what was typed.
  await page.route(`**/api/players/${ASH}`, (route) =>
    route.fulfill({ status: 400, contentType: 'application/json', json: { statusCode: 400, message: 'At most 100 characters' } }),
  );
  await page.getByRole('button', { name: 'Rename Ash Ketchum' }).click();
  await nameBox(ASH).fill('Too long, says the server');
  await nameBox(ASH).press('Enter');
  // The toast, plus the copy its live region announces.
  await expect(page.getByText('At most 100 characters').first()).toBeVisible();
  await expect(nameBox(ASH)).toHaveValue('Too long, says the server');
  expect(calls.patches).toBe(1);
  await page.unroute(`**/api/players/${ASH}`);
  await staffRow(page, ASH).getByRole('button', { name: 'Cancel' }).click();

  // The search box searches the staff list: one request once typing stops.
  const search = page.getByPlaceholder('Search name or ID');
  const ash = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/staff' && new URL(r.url()).searchParams.get('q') === 'ash');
  calls.staff = [];
  await search.pressSequentially('ash');
  await ash;
  await expect(staffRow(page, BROCK)).toHaveCount(0);
  await expect(staffRow(page, ASH)).toBeVisible();
  expect(calls.staff.map((u) => u.searchParams.get('q'))).toEqual(['ash']);
  await search.fill('zzz');
  await expect(page.getByText('No staff match.')).toBeVisible();

  // Back on All: the players list, never the staff list; the roles were fetched once.
  const everyone = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/staff' && !new URL(r.url()).searchParams.has('q'));
  await search.fill('');
  await everyone;
  calls.staff = [];
  const players = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/players');
  await page.getByRole('tab', { name: 'All' }).click();
  await players;
  await expect(page.getByRole('link', { name: 'Change thresholds' })).toHaveCount(0);
  expect(calls.staff).toEqual([]);
  // Back on Staff, wait for the list to be fetched again: a second roles request would go out with it.
  const again = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/staff');
  await page.getByRole('tab', { name: 'Staff' }).click();
  await again;
  await expect(staffRow(page, BROCK)).toBeVisible();
  expect(calls.roles).toBe(1);
});

test('with no staff yet, the Staff tab points to the import in Settings', async ({ page, api }) => {
  void api; // the fixture logs the organizer in; the staff list needs no Pokémon connection
  await page.goto('/players?tab=staff');
  await expect(page.getByText('No staff yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Import staff from play-tools in Settings' })).toHaveAttribute('href', '/settings');
  await expect(page.getByRole('link', { name: 'Change thresholds' })).toHaveCount(0);
});

test('at 360 px a long name stays inside the page, and a nameless staffer can be named', async ({ page, connected, fake }) => {
  const LONG = `${'A'.repeat(50)} ${'B'.repeat(49)}`;
  await staffTournament(fake, connected, [
    { id: ASH, role: 'judge', first: LONG.slice(0, 50), last: LONG.slice(51) },
    { id: BROCK, role: 'judge', first: '', last: '' },
  ]);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/players?tab=staff');

  await expect(staffRow(page, ASH)).toContainText(LONG);
  const nameless = staffRow(page, BROCK);
  await expect(nameless.getByText('No name')).toHaveClass(/italic/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

  await page.getByRole('button', { name: `Rename ${BROCK}` }).click();
  await expect(page.getByRole('textbox', { name: `Name for ${BROCK}` })).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
