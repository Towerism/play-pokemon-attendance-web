import { readFileSync } from 'node:fs';
import { fakeRecord } from '../server/fake-pokemon';
import { type Api, STAFF_ID, TUESDAY, addSessionPlayer, expect, finishedStatus, fixtureFile, playSession, startSubmission, test } from './fixtures';

// Clear session deletes every player record in one play session in
// play-tools, including ones entered there directly, and never a staff
// record. On a date with two play sessions the organizer must clear exactly
// the one the dialog previewed, only after typing the date, and This week and
// History must show the end state.

const EVENING = 'ps-evening';
const AFTERNOON = 'ps-afternoon';
const R = '8100003'; // a regular
const A = '8100001'; // in clear.tdf
const T = '8100002'; // in clear.tdf
const X = '8100009'; // entered in play-tools directly
const Q1 = '8100004'; // submitted to the other play session
const NAMES: Record<string, string> = { [R]: 'Rae Regular', [A]: 'Ava Attendee', [T]: 'Toby Tourney', [X]: 'Xan Extra', [Q1]: 'Quinn Other' };
const NO_SESSION_DATE = '2026-10-20';

const upstreamIds = (records: Map<string, { participant: { player_id: string } }[]>, session: string) =>
  (records.get(session) ?? []).map((r) => r.participant.player_id).sort();

async function ok(res: Response, what: string, status = 200): Promise<Response> {
  expect(res.status, what).toBe(status);
  return res;
}

async function importTdf(api: Api, date: string, name: string): Promise<void> {
  const body = { filename: name, content: readFileSync(fixtureFile(name), 'utf8') };
  const preview = await ok(await api.request(`/api/sessions/${date}/tdf`, { method: 'POST', json: body }), 'preview tdf');
  const { uploadId } = (await preview.json()) as { uploadId: number };
  await ok(await api.request(`/api/sessions/${date}/tdf/${uploadId}/commit`, { method: 'POST', json: {} }), 'commit tdf');
}

test('clear session deletes exactly the previewed session’s players, after typing the date, and This week and History show it', async ({
  page,
  fake,
  connected: api,
}) => {
  await test.step('setup: Q1 on the afternoon session, R, A and T on the evening one', async () => {
    fake.playSessions = [playSession(AFTERNOON, '2026-10-13T19:00:00Z'), playSession(EVENING, '2026-10-13T23:00:00Z')];
    fake.records = new Map([[EVENING, [fakeRecord(STAFF_ID, { role: 'organizer' }), fakeRecord(X, { first: 'Xan', last: 'Extra' })]]]);

    // A submission sends everyone listed for the date, so Q1 goes first and alone.
    await addSessionPlayer(api, TUESDAY, Q1, NAMES[Q1]!);
    expect(await finishedStatus(api, await startSubmission(api, TUESDAY, AFTERNOON))).toBe('succeeded');
    await ok(await api.request(`/api/sessions/${TUESDAY}/players/${Q1}`, { method: 'DELETE' }), 'remove Q1', 204);

    await ok(await api.request('/api/regulars', { method: 'POST', json: { playerId: R, name: NAMES[R] } }), 'add regular', 201);
    await importTdf(api, TUESDAY, 'clear.tdf');
    await ok(await api.request(`/api/sessions/${TUESDAY}/regulars/${R}`, { method: 'PUT', json: { present: true } }), 'tick R present');
    expect(await finishedStatus(api, await startSubmission(api, TUESDAY, EVENING))).toBe('succeeded');
    await addSessionPlayer(api, TUESDAY, Q1, NAMES[Q1]!);

    expect(upstreamIds(fake.records, AFTERNOON)).toEqual([Q1]);
    expect(upstreamIds(fake.records, EVENING)).toEqual([STAFF_ID, X, R, A, T].sort());
  });
  const playerRecords = fake.records.get(EVENING)!.filter((r) => r.player).map((r) => r.guid);

  const clearRequests: { playSessionId: string; confirmDate: string }[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/clear')) clearRequests.push(req.postDataJSON());
  });
  const dialog = page.getByRole('dialog', { name: 'Clear session' });
  const clearButton = dialog.getByRole('button', { name: 'Clear session', exact: true });
  const confirmField = dialog.getByLabel(`Type ${TUESDAY} to confirm`);
  const players = dialog.getByRole('listitem');
  const sessionTable = page.getByRole('table').first();
  const presentR = page.getByRole('checkbox', { name: NAMES[R] });
  const submittedBadge = page.getByText('Submitted', { exact: true });
  const tdfPreview = page.getByRole('dialog', { name: 'Tuesday Clear Night' });
  const alreadyImported = tdfPreview.getByText('This file was already imported for this date.');

  await test.step('a date with no play session has nothing to clear', async () => {
    await page.goto(`/?date=${NO_SESSION_DATE}`);
    await page.getByRole('button', { name: 'Clear session…' }).click();
    await expect(page.getByRole('dialog', { name: 'Clear session' }).getByText(`No play session exists on ${NO_SESSION_DATE} in play-tools.`)).toBeVisible();
    await expect(players).toHaveCount(0);
    await expect(clearButton).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  await test.step('before the clear: submitted, R present, the file already imported', async () => {
    await page.goto(`/?date=${TUESDAY}`);
    await expect(submittedBadge).toBeVisible();
    await page.getByRole('button', { name: /^Regulars \(1\)/ }).click();
    await expect(presentR).toBeChecked();
    await page.locator('input[type="file"]').setInputFiles(fixtureFile('clear.tdf'));
    await expect(alreadyImported).toBeVisible();
    await tdfPreview.getByRole('button', { name: 'Cancel' }).click();
    await expect(tdfPreview).toBeHidden();
  });

  await test.step('the preview follows the chosen play session', async () => {
    await page.getByRole('button', { name: 'Clear session…' }).click();
    await dialog.getByRole('radio', { name: /2:00/ }).check();
    await expect(players).toHaveText([NAMES[Q1]!]);
    await dialog.getByRole('radio', { name: /6:00/ }).check();
    await expect(players).toHaveCount(4);
    expect((await players.allInnerTexts()).map((t) => t.trim()).sort()).toEqual(
      [NAMES[R], NAMES[A], NAMES[T], `${NAMES[X]} · entered in play-tools`].sort(),
    );
    await expect(dialog.getByText(/1 staff record stays\./)).toBeVisible();
    await expect(dialog.getByText(/Another play session that day also has players from this app/)).toBeVisible();
  });

  await test.step('nothing is sent until the date is typed exactly', async () => {
    await confirmField.press('Enter');
    await expect(clearButton).toBeDisabled();
    await confirmField.fill('2026-10-14');
    await expect(clearButton).toBeDisabled();
    await confirmField.press('Enter');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(clearRequests).toEqual([]);
  });

  let clearId = 0;
  await test.step('typing the date clears the evening session', async () => {
    await page.getByRole('button', { name: 'Clear session…' }).click();
    await dialog.getByRole('radio', { name: /6:00/ }).check();
    await expect(players).toHaveCount(4);
    await confirmField.fill(TUESDAY);
    await expect(clearButton).toBeEnabled();
    const started = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/clear'));
    await clearButton.click();
    clearId = ((await (await started).json()) as { submissionId: number }).submissionId;
    await expect(dialog.getByText('Done', { exact: true })).toBeVisible();
    expect(clearRequests).toEqual([{ playSessionId: EVENING, confirmDate: TUESDAY }]);
  });

  await test.step('play-tools: only the evening session’s player records were deleted', async () => {
    const deleted = fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.path.split('/').at(-2));
    expect(deleted.sort()).toEqual([...playerRecords].sort());
    expect(upstreamIds(fake.records, EVENING)).toEqual([STAFF_ID]);
    expect(upstreamIds(fake.records, AFTERNOON)).toEqual([Q1]);
  });

  await test.step('This week: cleared players gone, Q1 stays, R still a regular but not present', async () => {
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    for (const id of [A, T]) await expect(sessionTable.getByRole('row').filter({ hasText: id })).toHaveCount(0);
    await expect(sessionTable.getByRole('row').filter({ hasText: Q1 })).toHaveCount(1);
    await expect(presentR).not.toBeChecked();
    await expect(submittedBadge).toHaveCount(0);
  });

  await test.step('History: a cleared-session row, and every player removed', async () => {
    await page.goto('/history');
    const row = page.getByRole('row').filter({ hasText: 'Cleared session' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/6:00/);
    await expect(row.getByText('Done', { exact: true })).toBeVisible();
    await page.goto(`/history/${clearId}`);
    for (const id of [R, A, T, X]) await expect(page.getByRole('row').filter({ hasText: NAMES[id]! })).toContainText('Removed');
  });

  await test.step('the same file imports again', async () => {
    await page.goto(`/?date=${TUESDAY}`);
    await page.locator('input[type="file"]').setInputFiles(fixtureFile('clear.tdf'));
    await expect(tdfPreview).toBeVisible();
    await expect(tdfPreview.getByRole('button', { name: 'Import' })).toBeVisible();
    await expect(alreadyImported).toHaveCount(0);
  });
});
