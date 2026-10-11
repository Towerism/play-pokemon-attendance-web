import { fakeRecord } from '../server/fake-pokemon';
import { STAFF_ID, TUESDAY, addSessionPlayer, expect, finishedStatus, playSession, startSubmission, test } from './fixtures';

// Undo deletes records in play-tools, so it must remove exactly what one
// submission added: not a later submission's players, not players added in
// play-tools directly, not staff. The organizer confirms who goes, and
// History and This week show the end state.

const PS = 'ps-tuesday';
const X = '8000009'; // added in play-tools directly
const A = '8000001';
const B = '8000002';
const C = '8000003';
const D = '8000004';
const NAMES: Record<string, string> = { [A]: 'Ada Alpha', [B]: 'Ben Beta', [C]: 'Cy Gamma', [D]: 'Dee Delta', [X]: 'Xan Extra' };

const upstreamIds = (records: Map<string, { participant: { player_id: string } }[]>) =>
  (records.get(PS) ?? []).map((r) => r.participant.player_id).sort();

test.beforeEach(async ({ fake }) => {
  fake.playSessions = [playSession(PS, '2026-10-13T23:00:00Z')];
  fake.records = new Map([[PS, [fakeRecord(STAFF_ID, { role: 'organizer' }), fakeRecord(X, { first: 'Xan', last: 'Extra' })]]]);
});

test('undo removes exactly what one submission added, and History and This week show it', async ({ page, fake, connected }) => {
  for (const id of [A, B, C]) await addSessionPlayer(connected, TUESDAY, id, NAMES[id]!);
  const s1 = await startSubmission(connected, TUESDAY, PS);
  expect(await finishedStatus(connected, s1)).toBe('succeeded');
  await addSessionPlayer(connected, TUESDAY, D, NAMES[D]!);
  const s2 = await startSubmission(connected, TUESDAY, PS);
  expect(await finishedStatus(connected, s2)).toBe('succeeded');

  // Someone already deleted B by hand in play-tools.
  const recordOf = (id: string) => fake.records.get(PS)!.find((r) => r.participant.player_id === id)!.guid;
  const [recA, recB, recC] = [recordOf(A), recordOf(B), recordOf(C)];
  fake.records.set(PS, fake.records.get(PS)!.filter((r) => r.guid !== recB));

  const undoCalls: string[] = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/undo')) undoCalls.push(req.url());
  });

  // The confirm dialog lists exactly S1's players; Cancel sends nothing.
  await page.goto(`/history/${s1}`);
  const undoButton = page.getByRole('button', { name: 'Remove players added by this submission' });
  await undoButton.click();
  const confirm = page.getByRole('dialog', { name: 'Remove players added by this submission' });
  await expect(confirm.getByRole('listitem')).toHaveText([NAMES[A]!, NAMES[B]!, NAMES[C]!]);
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  expect(undoCalls).toEqual([]);

  await undoButton.click();
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page).toHaveURL(/\/history\/\d+$/);
  await expect(page.getByRole('link', { name: `#${s1}` })).toBeVisible();
  await expect(page.getByText('Done', { exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: NAMES[A]! })).toContainText('Removed');
  await expect(page.getByRole('row').filter({ hasText: NAMES[C]! })).toContainText('Removed');
  await expect(page.getByRole('row').filter({ hasText: NAMES[B]! })).toContainText('Already gone');

  // play-tools: only A's and C's records were deleted; D, X and staff stay.
  const deleted = fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.path.split('/').at(-2));
  expect(deleted.sort()).toEqual([recA, recC].sort());
  expect(upstreamIds(fake.records)).toEqual([STAFF_ID, X, D].sort());

  // History: the undo row, S1 done with, S2 still undoable.
  await page.goto('/history');
  const undoRow = page.getByRole('row').filter({ hasText: `Undo of #${s1}` });
  await expect(undoRow).toHaveCount(1);
  await expect(undoRow.getByText('Done', { exact: true })).toBeVisible();
  await page.goto(`/history/${s1}`);
  await expect(page.getByText('Already undone')).toBeVisible();
  await expect(undoButton).toHaveCount(0);
  await page.goto(`/history/${s2}`);
  await expect(undoButton).toBeVisible();

  // This week: the undone players are off the date's list; D stays.
  await page.goto(`/?date=${TUESDAY}`);
  const sessionTable = page.getByRole('table').first();
  await expect(sessionTable.getByRole('row').filter({ hasText: D })).toHaveCount(1);
  for (const id of [A, B, C]) await expect(sessionTable.getByRole('row').filter({ hasText: id })).toHaveCount(0);
});

test('undo is refused while another submission runs, and works once it is done', async ({ page, fake, connected }) => {
  await addSessionPlayer(connected, TUESDAY, A, NAMES[A]!);
  const s1 = await startSubmission(connected, TUESDAY, PS);
  expect(await finishedStatus(connected, s1)).toBe('succeeded');

  // S3 holds the league's lock while play-tools takes its time.
  await addSessionPlayer(connected, TUESDAY, B, NAMES[B]!);
  fake.bulkDelayMs = 3_000;
  const s3 = await startSubmission(connected, TUESDAY, PS);

  await page.goto(`/history/${s1}`);
  await page.getByRole('button', { name: 'Remove players added by this submission' }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove players added by this submission' });
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText(/already running/).first()).toBeVisible();
  expect(fake.requests.filter((r) => r.method === 'DELETE')).toEqual([]);

  fake.bulkDelayMs = 0;
  expect(await finishedStatus(connected, s3)).toBe('succeeded');
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('link', { name: `#${s1}` })).toBeVisible();
  await expect(page.getByText('Done', { exact: true })).toBeVisible();
  expect(upstreamIds(fake.records)).toEqual([STAFF_ID, X, B].sort());
});
