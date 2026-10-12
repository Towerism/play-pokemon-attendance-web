import type { Locator, Page, Request } from '@playwright/test';
import { type FakePokemon, fakeRecord, fakeTournament } from '../server/fake-pokemon';
import { type Api, STAFF_ID, TUESDAY, addSessionPlayer, connectOverApi, expect, finishedStatus, loggedInUrl, test } from './fixtures';

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

const BROCK = '0000222';
const BROCK_CUP = 'brock-cup';
const BROCK_CUP_LABEL = `League Challenge ${BROCK_CUP} · 26-10-${BROCK_CUP}`;

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

/** Connects another professor in the default league and names them, as Settings would (#75). */
async function connectProfessor(api: Api, fake: FakePokemon, playerId: string, name: string) {
  const account = fake.addAccount({ playerId, name, leagues: fake.leagues });
  const start = await api.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL(((await start.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!;
  expect((await api.request('/api/pokemon/connect/complete', { method: 'POST', json: { url: loggedInUrl(state, account.code) } })).status).toBe(200);
  expect((await api.request(`/api/pokemon/connections/${playerId}`, { method: 'PATCH', json: { name } })).status).toBe(200);
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

/** Holds every response matching `url` until the returned function is called, so that read stays loading. */
async function holdResponses(page: Page, url: string): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(url, async (route) => {
    await released;
    await route.continue();
  });
  return release;
}

test("changing the date shows the tournaments loading, never the previous date's cards", async ({ page, connected: _connected, fake }) => {
  cupTonight(fake);
  const NEXT_WEEK = '2026-10-20';
  const staff = page.getByRole('region', { name: 'Staff', exact: true });
  const loading = staff.getByRole('status');
  const releaseTuesday = await holdResponses(page, `**/api/sessions/${TUESDAY}/staff`);
  await page.goto(`/?date=${TUESDAY}`);

  await expect(loading).toHaveText('Reading the tournaments from play-tools…');
  releaseTuesday();
  await expect(staffCard(page).getByRole('heading', { name: CUP_LABEL })).toBeVisible();
  await expect(loading).toHaveCount(0);

  const releaseNextWeek = await holdResponses(page, `**/api/sessions/${NEXT_WEEK}/staff`);
  await page.getByLabel('Session date').fill(NEXT_WEEK);
  await expect(loading).toHaveText('Reading the tournaments from play-tools…');
  await expect(staffCard(page)).toHaveCount(0);
  await expect(staff.getByText(/Times are in/)).toHaveCount(0);

  releaseNextWeek();
  await expect(staff.getByText(`No tournament in this league on ${NEXT_WEEK} in play-tools.`)).toBeVisible();
  await expect(loading).toHaveCount(0);
});

test("another professor's refused login hides only their tournaments: the Staff section names them and links to Settings, with no banner", async ({ page, api, fake }) => {
  cupTonight(fake);
  // Short-lived access tokens, so the app must refresh on its next use; then Brock's login is refused.
  fake.accessTtl = 60;
  await connectOverApi(api);
  await connectProfessor(api, fake, BROCK, 'Brock Harrison');
  fake.revokeChain(BROCK);
  await page.goto(`/?date=${TUESDAY}`);

  const staff = page.getByRole('region', { name: 'Staff', exact: true });
  await expect(staff.getByText('Reconnect Brock Harrison in Settings to see their tournaments.')).toBeVisible();
  await expect(staff.getByRole('link', { name: 'Open Settings' })).toBeVisible();
  await expect(staffCard(page).getByText('Organized by Professor 9999991')).toBeVisible();
  // Brock doesn't submit attendance, so the global banner stays down (#66).
  await expect(page.getByText(/no longer accepts/)).toHaveCount(0);
});

test("every professor's tournaments load on This week, each staffed as its organizer", async ({ page, connected, fake }) => {
  cupTonight(fake);
  await connectProfessor(connected, fake, BROCK, 'Brock Harrison');
  // Brock runs an earlier tournament the same evening; his listing fails once, then works.
  fake.tournaments.push(fakeTournament(BROCK_CUP, { startsAt: '2026-10-13T23:00:00Z', organizer: BROCK }));
  fake.tournamentRecords.set(BROCK_CUP, [fakeRecord(BROCK, { role: 'organizer' })]);
  fake.failOnce.set(`/services/core/activities@${BROCK}`, 502);
  await page.goto(`/?date=${TUESDAY}`);

  const staff = page.getByRole('region', { name: 'Staff', exact: true });
  await expect(staffCard(page).getByText('Organized by Professor 9999991')).toBeVisible();
  const warning = staff.getByText("Couldn't read Brock Harrison's tournaments from play-tools.");
  await expect(warning).toBeVisible();
  const reread = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/sessions/${TUESDAY}/staff`);
  await staff.getByRole('button', { name: 'Try again' }).click();
  await reread;
  await expect(warning).toHaveCount(0);
  const brocks = staffCard(page, BROCK_CUP_LABEL);
  await expect(brocks.getByText('Organized by Brock Harrison')).toBeVisible();

  // Staff on Brock's tournament goes out as Brock, and the dialog says so.
  const res = await connected.request(`/api/sessions/${TUESDAY}/staff`, { method: 'POST', json: { tournamentId: BROCK_CUP, playerId: ASH_PLAYER, role: 'judge', name: 'Ash Player' } });
  expect(res.status).toBe(201);
  await page.reload();
  await staffCard(page, BROCK_CUP_LABEL).getByRole('button', { name: 'Assign staff in play-tools' }).click();
  const dialog = page.getByRole('dialog', { name: `Staff for ${BROCK_CUP_LABEL}` });
  await expect(dialog.getByTestId('staff-runs-as')).toHaveText('Assigned as Brock Harrison (0000222), who organizes this tournament.');
  await expect(dialog).toContainText('1 assigned', { timeout: 20_000 });
  const writes = fake.requests.filter((r) => r.method === 'POST' && r.path === `/services/core/tournaments/${BROCK_CUP}/records`);
  expect(writes.map((r) => r.as)).toEqual([BROCK]);
  expect(fake.tournamentRecords.get(BROCK_CUP)!.map((r) => r.participant.player_id)).toContain(ASH_PLAYER);
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

test.describe('assign staff for all tournaments (#76)', () => {
  /** Tonight's cup (the organizer's) and Brock's earlier one, each wanting one judge. */
  async function twoTournamentsWantingStaff(api: Api, fake: FakePokemon) {
    cupTonight(fake);
    await connectProfessor(api, fake, BROCK, 'Brock Harrison');
    fake.tournaments.push(fakeTournament(BROCK_CUP, { startsAt: '2026-10-13T23:00:00Z', organizer: BROCK }));
    fake.tournamentRecords.set(BROCK_CUP, [fakeRecord(BROCK, { role: 'organizer' })]);
    await wantStaff(api, ASH_PLAYER, 'judge', 'Ash Player');
    const res = await api.request(`/api/sessions/${TUESDAY}/staff`, { method: 'POST', json: { tournamentId: BROCK_CUP, playerId: ASH_JUDGE, role: 'judge', name: 'Ash Judge' } });
    expect(res.status).toBe(201);
  }
  const staffWrites = (fake: FakePokemon) =>
    fake.requests.filter((r) => r.method === 'POST' && /^\/services\/core\/tournaments\/[^/]+\/records$/.test(r.path)).map((r) => [r.path.split('/')[4], r.as]);
  const rows = (page: Page) => page.getByRole('dialog', { name: 'Staff for all tournaments' }).getByTestId('staff-batch-row');

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 360, height: 780 } });

    test("runs every tournament's staff in turn, each as its organizer, and refreshes every card", async ({ page, connected, fake }) => {
      await twoTournamentsWantingStaff(connected, fake);
      // Slow writes keep the batch running long enough to try dismissing, closing and reopening it.
      fake.staffPostDelayMs = 3_000;
      await page.goto(`/?date=${TUESDAY}`);

      await page.getByRole('button', { name: 'Assign staff for all tournaments' }).click();
      const dialog = page.getByRole('dialog', { name: 'Staff for all tournaments' });
      await expect(dialog).toContainText('it keeps going');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
      // Close leaves it running, and the section offers it again.
      await dialog.getByRole('button', { name: 'Close' }).last().click();
      await expect(dialog).toBeHidden();
      await page.getByRole('button', { name: 'Assigning staff for all tournaments… Show' }).click();
      await expect(dialog).toBeVisible();

      await expect(dialog.getByTestId('staff-batch-status')).toHaveText('Done', { timeout: 30_000 });
      await expect(rows(page).nth(0)).toContainText(BROCK_CUP_LABEL);
      await expect(rows(page).nth(0)).toContainText('As Brock Harrison');
      await expect(rows(page).nth(1)).toContainText(CUP_LABEL);
      await expect(rows(page)).toContainText(['Done', 'Done']);
      await expect(page.getByText('Staff for all tournaments: Done', { exact: true })).toBeVisible();
      expect(staffWrites(fake)).toEqual([
        [BROCK_CUP, BROCK],
        [CUP, STAFF_ID],
      ]);

      await dialog.getByRole('button', { name: 'Close' }).last().click();
      await expect(wantedRow(staffCard(page), ASH_PLAYER)).toContainText('In play-tools');
      await expect(wantedRow(staffCard(page, BROCK_CUP_LABEL), ASH_JUDGE)).toContainText('In play-tools');
    });
  });

  test('a failed tournament leaves the batch partly done, and Retry failed runs only it again', async ({ page, connected, fake }) => {
    await twoTournamentsWantingStaff(connected, fake);
    fake.lockedTournaments = new Set([CUP]);
    await page.goto(`/?date=${TUESDAY}`);

    await page.getByRole('button', { name: 'Assign staff for all tournaments' }).click();
    const dialog = page.getByRole('dialog', { name: 'Staff for all tournaments' });
    await expect(dialog.getByTestId('staff-batch-status')).toHaveText('Partly done', { timeout: 30_000 });
    await expect(rows(page)).toContainText(['Done', 'Failed']);

    fake.lockedTournaments = new Set();
    const retried = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === `/api/sessions/${TUESDAY}/staff/apply-all`);
    await dialog.getByRole('button', { name: 'Retry failed' }).click();
    expect((await retried).postDataJSON()).toEqual({ tournamentIds: [CUP] });
    await expect(dialog.getByTestId('staff-batch-status')).toHaveText('Done', { timeout: 30_000 });
    await expect(rows(page)).toHaveCount(1);
    expect(staffWrites(fake).filter(([t]) => t === BROCK_CUP)).toHaveLength(1);
  });
});
