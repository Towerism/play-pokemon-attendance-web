import type { Page } from '@playwright/test';
import { tomTdf } from '../../shared/tdf/__fixtures__/tom';
import { localInstant } from '../../shared/time/local-time';
import { type FakePokemon, fakeRecord, fakeTournament } from '../server/fake-pokemon';
import { LEAGUE_TZ, STAFF_ID, dayHeading, expect, expectNoHorizontalScroll, leagueDay, plannedTournament, test, tournamentTemplate } from './fixtures';

// This week's tournament cards (#99, ADR-0010 decision 10, ADR-0011). The client decides what reaches play-tools:
// nothing goes to its TDF validation before the dialog's confirm, the confirm carries the fingerprint of exactly the
// warnings shown, and Remove from staff removes only whom its confirm names. The fake's request log is the oracle.

const GUID = '00000000-0000-4000-8000-0000000000e1';
const DATE = leagueDay(-1);
const DISPLAY_ID = '26-10-990001';
const LABEL = `League Challenge e1 · ${DISPLAY_ID}`;
const ASH = { userid: '1234567', first: 'Ash', last: 'Ketchum' };
const MISTY = { userid: '2345678', first: 'Misty', last: 'Waterflower' };

const validates = (fake: FakePokemon) => fake.requests.filter((r) => r.method === 'POST' && r.path === '/services/triumph/tdf/');
const card = (page: Page) => page.getByRole('region', { name: LABEL });
const results = (page: Page) => card(page).getByRole('region', { name: 'Results' });

/** Yesterday's sanctioned tournament with no players yet, run by the connected organizer, plus `staff`. */
function heldYesterday(fake: FakePokemon, staff: ReturnType<typeof fakeRecord>[] = []) {
  const t = fakeTournament('e1', { startsAt: localInstant(DATE, '18:00', LEAGUE_TZ).toISOString(), organizer: STAFF_ID, displayId: DISPLAY_ID });
  t.guid = GUID;
  fake.tournaments.push(t);
  fake.tournamentRecords.set(GUID, [fakeRecord(STAFF_ID, { role: 'organizer', first: 'Olive', last: 'Organizer' }), ...staff]);
}

/** A TOM file for the tournament; by default its organizer is the tournament's. */
function tdf(opts: { organizer?: { popid: string; name: string } } = {}) {
  const organizer = opts.organizer ?? { popid: STAFF_ID, name: 'Olive Organizer' };
  const content = tomTdf({ players: [ASH, MISTY], idElement: `<id>${DISPLAY_ID}</id>`, organizerElement: `<organizer popid="${organizer.popid}" name="${organizer.name}"/>` });
  return { name: 'cup.tdf', mimeType: 'application/xml', buffer: Buffer.from(content) };
}

test('a file naming another organizer is fixed with the saved full name, and uploads only after Upload anyway, with attendance', async ({ page, connected, fake }) => {
  void connected;
  heldYesterday(fake);
  await page.setViewportSize({ width: 412, height: 915 });
  const coverageReads: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/tournaments/requirements') coverageReads.push(r.url());
  });
  await page.goto(`/?date=${DATE}`);

  // The required-events banner: the seeded League Challenges of last month are missed or in their last chance.
  const banner = page.getByRole('region', { name: 'Required events' }).or(page.getByRole('alert').filter({ hasText: 'Required events' }));
  await expect(banner.getByText(/League Challenge for TCG/).first()).toBeVisible();
  await expect(banner.getByRole('link', { name: 'Open Tournaments' })).toHaveAttribute('href', '/tournaments');
  await expect(banner.getByRole('button', { name: /close|dismiss/i })).toHaveCount(0);

  // The card: its status and display id from the date's Upcoming read, and Edit… in its menu.
  await expect(card(page).getByText('In play-tools', { exact: true })).toBeVisible();
  await card(page).getByRole('button', { name: `Tournament actions for ${LABEL}` }).click();
  await page.getByRole('menuitem', { name: 'Edit…' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit tournament' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Edit tournament' })).toBeHidden();

  await expect(results(page).getByText('Awaiting results')).toBeVisible();
  await results(page).locator('input[type="file"]').setInputFiles(tdf({ organizer: { popid: '1230000', name: 'Someone Else' } }));

  // The organizer's full name is asked once, pre-filled with play-tools' name.
  const dialog = page.getByRole('dialog', { name: 'Upload results' });
  const fullName = dialog.getByRole('textbox', { name: /full name, as it should appear in the TDF/ });
  await expect(fullName).toHaveValue('Olive Organizer');
  await expect(dialog.getByRole('button', { name: 'Upload anyway' })).toHaveCount(0);
  const named = page.waitForResponse((r) => r.url().endsWith('/organizer') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Save name' }).click();
  const { fingerprint } = (await (await named).json()) as { fingerprint: string };

  // The replaced organizer first, then the players new to the app; attendance ticked; nothing sent yet.
  await expect(dialog.getByRole('list', { name: 'Warnings' }).getByRole('listitem').first()).toContainText('The file names 1230000 (Someone Else) as organizer');
  await expect(dialog.getByRole('list', { name: 'Not in the app yet' })).toContainText('Misty Waterflower');
  await expect(dialog.getByRole('checkbox', { name: /Also import attendance/ })).toBeChecked();
  await expect(dialog.getByText('This file has problems.', { exact: false })).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(validates(fake)).toEqual([]);

  const sent = page.waitForRequest((r) => r.url().endsWith('/confirm') && r.method() === 'POST');
  await dialog.getByRole('button', { name: 'Upload anyway' }).click();
  expect((await sent).postDataJSON()).toEqual({ importAttendance: true, acknowledgedWarnings: fingerprint });
  await expect(dialog.getByRole('list', { name: 'Tournaments in this job' })).toContainText('Processing in play-tools');
  expect(validates(fake)).toHaveLength(1);
  expect(fake.validatedFiles[0]).toContain(`popid="${STAFF_ID}"`);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Results follow processing on read, and the file's players were imported as session players.
  await expect(results(page).getByText('Processing in play-tools')).toBeVisible();
  await expect(results(page).locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole('table').first()).toContainText(MISTY.userid);
  fake.finishUpload(GUID, 'completed');
  await page.reload();
  await expect(results(page).getByText('Complete', { exact: true }).first()).toBeVisible();
  await expect(results(page).getByRole('button', { name: `Download TDF ${LABEL}` })).toBeVisible();
  await expectNoHorizontalScroll(page);
  // The badge and the banner share one coverage read per page load.
  expect(coverageReads).toHaveLength(2);
});

test('Remove from staff names whom it removes, removes only them, and the warnings shown are current', async ({ page, connected, fake }) => {
  void connected;
  heldYesterday(fake, [fakeRecord(ASH.userid, { role: 'judge', first: 'Ash', last: 'Ketchum' })]);
  await page.goto(`/?date=${DATE}`);
  await results(page).locator('input[type="file"]').setInputFiles(tdf());

  const dialog = page.getByRole('dialog', { name: 'Upload results' });
  const alsoOnStaff = dialog.getByRole('list', { name: 'Also on staff' });
  await expect(alsoOnStaff).toContainText('Ash Ketchum');
  await dialog.getByRole('button', { name: 'Remove Ash Ketchum from staff' }).click();
  await expect(dialog.getByText(/Remove Ash Ketchum \(.+\) from this tournament’s staff in play-tools\?/)).toBeVisible();
  const deletes = () => fake.requests.filter((r) => r.method === 'DELETE');
  expect(deletes()).toEqual([]);

  await dialog.getByRole('button', { name: 'Remove from staff', exact: true }).click();
  await expect(alsoOnStaff).toBeHidden();
  expect(deletes()).toHaveLength(1);
  expect(fake.tournamentRecords.get(GUID)!.map((r) => r.participant.player_id)).toEqual([STAFF_ID]);
  // Only the players new to the app are left to acknowledge; nothing was validated.
  await expect(dialog.getByRole('button', { name: 'Upload anyway' })).toBeEnabled();
  expect(validates(fake)).toEqual([]);
});

test('a file play-tools does not accept shows why, and Upload again… sends nothing until its own confirm', async ({ page, connected, fake }) => {
  void connected;
  heldYesterday(fake);
  fake.tdfErrors.set(DISPLAY_ID, [{ type: 'STAFF_PLAYERS_ERROR', message: 'A staff member is listed as a player.' }]);
  await page.goto(`/?date=${DATE}`);
  await results(page).locator('input[type="file"]').setInputFiles(tdf());

  const dialog = page.getByRole('dialog', { name: 'Upload results' });
  await dialog.getByRole('button', { name: 'Upload anyway' }).click();
  await expect(dialog).toContainText('Not accepted by play-tools');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await expect(results(page).getByText('Not accepted', { exact: true })).toBeVisible();
  await expect(results(page)).toContainText('(STAFF_PLAYERS_ERROR)');
  await expect(results(page)).toContainText('Pokémon support can access the file from this failed attempt.');
  await expect(results(page).getByRole('link', { name: 'Details' })).toHaveAttribute('href', /\/history\/\d+$/);
  expect(validates(fake)).toHaveLength(1);

  await results(page).getByRole('button', { name: `Upload again… ${LABEL}` }).click();
  await expect(dialog.getByText('Sending gives Pokémon support another copy.')).toBeVisible();
  expect(validates(fake)).toHaveLength(1);
});

test('a planned tournament on the date is created from its card, and becomes a tournament card', async ({ page, connected, fake }) => {
  const template = await tournamentTemplate(connected);
  const date = leagueDay(20);
  await plannedTournament(connected, template.id, date);
  const creates = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/services/core/tournament');

  await page.goto(`/?date=${date}`);
  const planned = page.getByRole('region', { name: `Friday Cup · ${dayHeading(date)}` });
  await expect(planned.getByText('Planned', { exact: true })).toBeVisible();
  await expect(planned.getByText(/^Create by /)).toBeVisible();
  await planned.getByRole('button', { name: `Create in play-tools Friday Cup · ${dayHeading(date)}` }).click();

  const dialog = page.getByRole('dialog', { name: 'Create in play-tools' });
  await expect(dialog.getByRole('list', { name: 'Tournaments to create' })).toContainText('Friday Cup');
  expect(creates()).toEqual([]);
  await dialog.getByRole('button', { name: 'Create in play-tools' }).click();
  await expect(dialog.getByText('Done', { exact: true })).toBeVisible();
  expect(creates()).toHaveLength(1);
  await page.keyboard.press('Escape');

  await expect(planned).toBeHidden();
  const created = page.getByRole('region', { name: /^Friday Cup/ });
  await expect(created.getByText('In play-tools', { exact: true })).toBeVisible();
  await expect(created.getByRole('region', { name: 'Results' })).toBeVisible();
});
