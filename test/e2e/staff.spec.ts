import type { Locator, Page, Request } from '@playwright/test';
import { type FakePokemon, fakeRecord, fakeTournament } from '../server/fake-pokemon';
import { type Api, STAFF_ID, TUESDAY, addSessionPlayer, connectOverApi, expect, finishedStatus, test } from './fixtures';

// This week → Staff (ADR-0007): one card per tournament the league runs on the
// date. The client must never offer someone the app may not assign (the
// organizer, anyone play-tools lists, anyone already staffing), must send the
// right role and ID, and must show every refusal after "Assign staff in
// play-tools" without acting on it.

const CUP = 'tue-cup';
const CUP_LABEL = `League Challenge ${CUP} · 26-10-${CUP}`;
/** Tuesday 19:30 in the league's timezone (America/Chicago). */
const TUESDAY_EVENING = '2026-10-14T00:30:00Z';
const LAST_WEEK = '2026-10-06';
const LAST_CUP = 'last-cup';

const ASH_JUDGE = '6000011'; // on the staff list, last as Head Judge
const ASH_PLAYER = '6000012'; // a known player who never staffed
const ASH_UPSTREAM = '6000013'; // staff on the tournament, added in play-tools
const ASH_PLAYING = '6000014'; // playing in the tournament
const ASH_LOCAL = '6000015'; // already wanted as staff here

const staffCard = (page: Page, label = CUP_LABEL) => page.getByRole('region', { name: label });
const searchBox = (card: Locator, label = CUP_LABEL) => card.getByRole('combobox', { name: `Find staff for ${label}` });
const option = (page: Page, text: string) => page.getByRole('option').filter({ hasText: text });
const wantedRow = (card: Locator, playerId: string) => card.getByRole('list', { name: 'Wanted staff' }).getByRole('listitem').filter({ hasText: playerId });

/** This Tuesday's tournament, run by the organizer, with `records` besides the organizer's own. */
function cupTonight(fake: FakePokemon, records: ReturnType<typeof fakeRecord>[] = []) {
  fake.tournaments.push(fakeTournament(CUP, { startsAt: TUESDAY_EVENING, organizer: STAFF_ID }));
  fake.tournamentRecords.set(CUP, [fakeRecord(STAFF_ID, { role: 'organizer', first: 'Ash', last: 'Organizer', guid: 'rec-org' }), ...records]);
}

/** Last week's tournament, read once so the app puts its staff on the staff list. */
async function staffedLastWeek(fake: FakePokemon, api: Api, staff: { id: string; role: string; first: string; last: string }[]) {
  fake.tournaments.push(fakeTournament(LAST_CUP, { startsAt: '2026-10-07T00:30:00Z', organizer: STAFF_ID }));
  fake.tournamentRecords.set(LAST_CUP, [
    fakeRecord(STAFF_ID, { role: 'organizer' }),
    ...staff.map((s) => fakeRecord(s.id, { role: s.role, first: s.first, last: s.last })),
  ]);
  expect((await api.request(`/api/sessions/${LAST_WEEK}/staff`)).status).toBe(200);
}

async function wantStaff(api: Api, playerId: string, role: string, name?: string) {
  const res = await api.request(`/api/sessions/${TUESDAY}/staff`, { method: 'POST', json: { tournamentId: CUP, playerId, role, ...(name ? { name } : {}) } });
  expect(res.status, `want ${playerId}`).toBe(201);
}

async function applyOverApi(api: Api): Promise<string> {
  const res = await api.request(`/api/sessions/${TUESDAY}/staff/apply`, { method: 'POST', json: { tournamentId: CUP } });
  expect(res.status, 'apply').toBe(202);
  return finishedStatus(api, ((await res.json()) as { submissionId: number }).submissionId);
}

/** Staff adds the page sent (`POST /api/sessions/{date}/staff`). */
function spyStaffAdds(page: Page): Record<string, unknown>[] {
  const adds: Record<string, unknown>[] = [];
  page.on('request', (r: Request) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === `/api/sessions/${TUESDAY}/staff`) adds.push(r.postDataJSON() as Record<string, unknown>);
  });
  return adds;
}

/** Reads of the date's staff the page sent (`GET /api/sessions/{date}/staff`). */
function spyStaffReads(page: Page): string[] {
  const reads: string[] = [];
  page.on('request', (r: Request) => {
    if (r.method() === 'GET' && /^\/api\/sessions\/[^/]+\/staff$/.test(new URL(r.url()).pathname)) reads.push(r.url());
  });
  return reads;
}

async function pickRole(page: Page, select: Locator, label: string) {
  await select.click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

test('the staff search never offers someone the tournament already lists, its organizer, or someone staffing here', async ({ page, connected, fake }) => {
  await staffedLastWeek(fake, connected, [{ id: ASH_JUDGE, role: 'headjudge', first: 'Ash', last: 'Judge' }]);
  await addSessionPlayer(connected, LAST_WEEK, ASH_PLAYER, 'Ash Player');
  await addSessionPlayer(connected, LAST_WEEK, ASH_PLAYING, 'Ash Playing');
  await addSessionPlayer(connected, LAST_WEEK, STAFF_ID, 'Ash Organizer');
  cupTonight(fake, [fakeRecord(ASH_UPSTREAM, { role: 'scorekeeper', first: 'Ash', last: 'Upstream' }), fakeRecord(ASH_PLAYING)]);
  await wantStaff(connected, ASH_LOCAL, 'judge', 'Ash Local');

  const searches: URL[] = [];
  page.on('request', (r: Request) => {
    const url = new URL(r.url());
    if (url.pathname === '/api/staff' || url.pathname === '/api/players') searches.push(url);
  });
  const adds = spyStaffAdds(page);
  const reads = spyStaffReads(page);
  await page.goto(`/?date=${TUESDAY}`);
  const card = staffCard(page);
  await expect(card.getByRole('heading', { name: CUP_LABEL })).toBeVisible();
  await expect(page.getByText('Times are in America/Chicago.')).toBeVisible();
  expect(reads).toHaveLength(1);

  // Typed slower than the debounce: one character is never sent, two are, once to each list.
  const both = Promise.all(
    ['/api/staff', '/api/players'].map((path) => page.waitForRequest((r) => new URL(r.url()).pathname === path && new URL(r.url()).searchParams.get('q') === 'as')),
  );
  await searchBox(card).pressSequentially('as', { delay: 400 });
  await both;
  expect(searches.filter((u) => u.searchParams.get('q') === 'a')).toHaveLength(0);
  expect(searches.filter((u) => u.searchParams.get('q') === 'as').map((u) => [u.pathname, u.searchParams.get('limit')]).sort()).toEqual([
    ['/api/players', '20'],
    ['/api/staff', '20'],
  ]);

  // The staff list comes first, with the role they last staffed in.
  await expect(option(page, 'Ash Judge')).toContainText('last: Head Judge');
  const names = await page.getByRole('option').allTextContents();
  expect(names.findIndex((n) => n.includes('Ash Judge'))).toBeLessThan(names.findIndex((n) => n.includes('Ash Player')));

  for (const [name, tag] of [
    ['Ash Organizer', 'Organizer'],
    ['Ash Local', 'Staffing as Judge'],
    ['Ash Upstream', 'Scorekeeper in play-tools'],
    ['Ash Playing', 'Playing'],
  ]) {
    await expect(option(page, name!)).toContainText(tag!);
    await expect(option(page, name!)).toHaveAttribute('aria-disabled', 'true');
  }
  await expect(option(page, 'Ash Player')).not.toHaveAttribute('aria-disabled', 'true');

  // The keyboard never lands on someone who can't be picked, so Enter can't send them.
  const highlighted = page.locator('[role="option"][data-highlighted]');
  for (let presses = 0; presses < 8; presses++) {
    await searchBox(card).press('ArrowDown');
    await expect(highlighted).not.toHaveAttribute('aria-disabled', 'true');
  }
  expect(adds).toHaveLength(0);
});

test('picking a staffer sends their last role, a new staffer gets Judge, and add by ID keeps leading zeros', async ({ page, connected, fake }) => {
  await staffedLastWeek(fake, connected, [{ id: ASH_JUDGE, role: 'headjudge', first: 'Ash', last: 'Judge' }]);
  await addSessionPlayer(connected, LAST_WEEK, ASH_PLAYER, 'Ash Player');
  cupTonight(fake);
  const adds = spyStaffAdds(page);
  await page.goto(`/?date=${TUESDAY}`);
  const card = staffCard(page);
  const search = searchBox(card);

  await search.fill('ash judge');
  await option(page, 'Ash Judge').click();
  await expect(wantedRow(card, ASH_JUDGE)).toContainText('Not sent yet');
  await expect(card.getByRole('combobox', { name: 'Role for Ash Judge' })).toHaveText(/Head Judge/);
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();

  await search.fill('ash player');
  await option(page, 'Ash Player').click();
  await expect(card.getByRole('combobox', { name: 'Role for Ash Player' })).toHaveText(/Judge/);
  expect(adds).toEqual([
    { tournamentId: CUP, playerId: ASH_JUDGE, role: 'headjudge' },
    { tournamentId: CUP, playerId: ASH_PLAYER, role: 'judge' },
  ]);

  // A first-time staffer, by ID: the leading zero is kept, the role is the one chosen.
  const byId = card.getByRole('form', { name: 'Add staff by ID' });
  await byId.getByRole('textbox', { name: 'Player ID' }).fill('abc');
  await byId.getByRole('button', { name: 'Add staffer' }).click();
  await expect(byId).toContainText(/ID/);
  expect(adds).toHaveLength(2);
  await byId.getByRole('textbox', { name: 'Player ID' }).fill('0123456');
  await byId.getByRole('textbox', { name: 'Name' }).fill('Misty');
  await pickRole(page, byId.getByRole('combobox', { name: 'Role' }), 'Scorekeeper');
  await byId.getByRole('button', { name: 'Add staffer' }).click();
  await expect(wantedRow(card, '0123456')).toContainText('Misty');
  expect(adds[2]).toEqual({ tournamentId: CUP, playerId: '0123456', name: 'Misty', role: 'scorekeeper' });

  // Another date: the search starts empty.
  await search.fill('ash');
  await page.getByLabel('Session date').fill('2026-10-20');
  await expect(page.getByText('No tournament in this league on 2026-10-20 in play-tools.')).toBeVisible();
  await page.getByLabel('Session date').fill(TUESDAY);
  await expect(searchBox(staffCard(page))).toHaveValue('');
});

test('assigning staff shows every refusal with its reason and never applies a suggested id', async ({ page, connected, fake }) => {
  cupTonight(fake);
  await wantStaff(connected, '7000002', 'judge', 'Not Certified');
  await wantStaff(connected, '7000003', 'judge', 'Merged Away');
  await wantStaff(connected, '7000004', 'judge', 'Good Judge');
  fake.refuseStaff.set('7000002', 'op.activity_record.missing_certification');
  fake.refuseStaff.set('7000003', { code: 'op.activity_record.merged_player_id', attributes: { actual_player_id: '7000001' } });
  fake.staffPostDelayMs = 1_500;
  await page.goto(`/?date=${TUESDAY}`);
  const card = staffCard(page);

  await card.getByRole('button', { name: 'Assign staff in play-tools' }).click();
  const dialog = page.getByRole('dialog', { name: `Staff for ${CUP_LABEL}` });
  // While it runs (play-tools holds each assign), clicking outside or Escape doesn't close it.
  await expect(dialog.getByRole('progressbar')).toBeVisible();
  await page.mouse.click(5, 5);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();

  await expect(dialog).toContainText('1 assigned · 2 not eligible', { timeout: 20_000 });
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Not Certified' })).toContainText('missing_certification');
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Merged Away' })).toContainText('Merged into 7000001');

  await dialog.getByRole('link', { name: 'Details' }).click();
  await expect(page.getByText(`Staff for ${CUP_LABEL}`).first()).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Merged Away' })).toContainText('Merged into 7000001');
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);

  await page.goto(`/?date=${TUESDAY}`);
  await expect(wantedRow(staffCard(page), '7000004')).toContainText('In play-tools');
  // The suggestion was shown, never applied: the assignment keeps its id.
  await expect(wantedRow(staffCard(page), '7000003')).toContainText('Failed');
  await expect(wantedRow(staffCard(page), '7000001')).toHaveCount(0);
});

test('when play-tools fails, This week still works and Try again brings the staff back', async ({ page, connected, fake }) => {
  cupTonight(fake);
  await addSessionPlayer(connected, TUESDAY, '6000099', 'Walk In');
  fake.failOnce.set('/services/core/activities', 502);
  const reads = spyStaffReads(page);
  await page.goto(`/?date=${TUESDAY}`);

  const staff = page.getByRole('region', { name: 'Staff', exact: true });
  await expect(staff.getByRole('button', { name: 'Try again' })).toBeVisible();
  // One read per load: a failure is not resent to play-tools behind the organizer's back.
  expect(reads).toHaveLength(1);
  await expect(page.getByRole('table').first()).toContainText('Walk In');
  await page.getByRole('button', { name: 'Submit attendance' }).click();
  const submit = page.getByRole('dialog', { name: 'Submit attendance' });
  await expect(submit).toBeVisible();
  await expect(submit).not.toContainText(/staff/i);
  await submit.getByRole('button', { name: 'Cancel' }).click();

  await staff.getByRole('button', { name: 'Try again' }).click();
  await expect(staffCard(page).getByRole('heading', { name: CUP_LABEL })).toBeVisible();

  // No tournament that day.
  await page.getByLabel('Session date').fill('2026-10-20');
  await expect(page.getByText('No tournament in this league on 2026-10-20 in play-tools.')).toBeVisible();
  await expect(page.getByRole('combobox', { name: /Find staff for/ })).toHaveCount(0);
});

test('when Pokémon needs reconnecting, the Staff section links to Settings', async ({ page, api, fake }) => {
  cupTonight(fake);
  // Short-lived access tokens, so the app must refresh on its next use; then the login is refused.
  fake.accessTtl = 60;
  await connectOverApi(api);
  fake.revokeChain();
  await page.goto(`/?date=${TUESDAY}`);
  await expect(page.getByRole('region', { name: 'Staff', exact: true }).getByRole('link', { name: 'Open Settings' })).toBeVisible();
});

test('a tournament past its window, or gone from play-tools, offers no staff actions', async ({ page, connected, fake }) => {
  const JUNE = '2026-06-02';
  fake.tournaments.push(fakeTournament('june-cup', { startsAt: '2026-06-03T00:30:00Z', organizer: STAFF_ID }));
  fake.tournamentRecords.set('june-cup', [fakeRecord(STAFF_ID, { role: 'organizer' }), fakeRecord(ASH_UPSTREAM, { role: 'judge', first: 'Old', last: 'Judge' })]);
  await page.goto(`/?date=${JUNE}`);
  const june = staffCard(page, 'League Challenge june-cup · 26-10-june-cup');
  await expect(june).toContainText('Read-only: more than 90 days past its start.');
  await expect(june).toContainText('Old Judge');
  await expect(june.getByRole('combobox')).toHaveCount(0);
  await expect(june.getByRole('button')).toHaveCount(0);

  cupTonight(fake);
  await wantStaff(connected, ASH_LOCAL, 'judge', 'Ash Local');
  fake.tournaments = fake.tournaments.filter((t) => t.guid !== CUP);
  await page.goto(`/?date=${TUESDAY}`);
  const gone = staffCard(page);
  await expect(gone).toContainText('No longer listed in play-tools');
  await expect(gone).toContainText('Ash Local');
  await expect(gone.getByRole('combobox')).toHaveCount(0);
  await expect(gone.getByRole('button')).toHaveCount(0);
});

test("a role change shows what play-tools still holds, and reverts when it can't be saved", async ({ page, connected, fake }) => {
  cupTonight(fake);
  await wantStaff(connected, ASH_LOCAL, 'judge', 'Ash Local');
  expect(await applyOverApi(connected)).toBe('succeeded');
  await wantStaff(connected, ASH_PLAYER, 'judge', 'Ash Player');
  await page.goto(`/?date=${TUESDAY}`);
  const card = staffCard(page);
  const role = card.getByRole('combobox', { name: 'Role for Ash Local' });

  await pickRole(page, role, 'Scorekeeper');
  await expect(role).toHaveText(/Scorekeeper/);
  await expect(wantedRow(card, ASH_LOCAL)).toContainText('In play-tools as Judge; changes on the next apply');

  // A change the server refuses: the select goes back and the toast says why.
  await page.route('**/api/sessions/*/staff/*', (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 422, contentType: 'application/json', json: { statusCode: 422, message: 'This tournament can no longer be changed.', data: { code: 'tournament_locked' } } })
      : route.fallback(),
  );
  await pickRole(page, role, 'Translator');
  // The toast, plus the copy its live region announces.
  await expect(page.getByText('This tournament can no longer be changed.').first()).toBeVisible();
  await expect(role).toHaveText(/Scorekeeper/);
  await page.unroute('**/api/sessions/*/staff/*');

  await card.getByRole('button', { name: 'Remove Ash Player from staff' }).click();
  await expect(wantedRow(card, ASH_PLAYER)).toHaveCount(0);
});

test('someone listed in play-tools after the card loaded is refused and then shown as listed', async ({ page, connected, fake }) => {
  await addSessionPlayer(connected, LAST_WEEK, '6000016', 'Ash Late');
  await addSessionPlayer(connected, LAST_WEEK, '6000017', 'Ash Twice');
  cupTonight(fake);
  await page.goto(`/?date=${TUESDAY}`);
  const card = staffCard(page);
  const search = searchBox(card);
  await expect(card.getByRole('heading', { name: CUP_LABEL })).toBeVisible();

  fake.tournamentRecords.get(CUP)!.push(fakeRecord('6000016'));
  await search.fill('ash late');
  await option(page, 'Ash Late').click();
  await expect(page.getByText('Ash Late is already listed in play-tools as a player.').first()).toBeVisible();
  await search.fill('ash lat');
  await expect(option(page, 'Ash Late')).toContainText('Playing');
  await expect(option(page, 'Ash Late')).toHaveAttribute('aria-disabled', 'true');

  // Wanted in another role meanwhile (another tab): refused, and the query stays.
  await wantStaff(connected, '6000017', 'scorekeeper');
  await search.fill('ash twice');
  await option(page, 'Ash Twice').click();
  await expect(page.getByText('Player 6000017 is already wanted on this tournament as scorekeeper.').first()).toBeVisible();
  await expect(search).toHaveValue('ash twice');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('the Staff card fits at 360 px', async ({ page, connected, fake }) => {
    cupTonight(fake, [
      fakeRecord('6000021', { role: 'scorekeeper', first: 'Wolfeschlegelsteinhausenbergerdorff', last: 'Upstream' }),
      fakeRecord('6000022', { role: 'administration', first: 'Second', last: 'Upstream' }),
    ]);
    await wantStaff(connected, '6000023', 'headjudge', 'A Rather Long Staffer Name Indeed');
    await wantStaff(connected, '6000024', 'translator', 'Second Staffer');
    await wantStaff(connected, '6000025', 'judge', 'Third Staffer');
    await page.goto(`/?date=${TUESDAY}`);
    await expect(wantedRow(staffCard(page), '6000025')).toBeVisible();
    await expect(staffCard(page)).toContainText('Second Upstream');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  });
});
