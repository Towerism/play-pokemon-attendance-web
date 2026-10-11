import type { Locator, Page } from '@playwright/test';
import { fakeRecord } from '../server/fake-pokemon';
import { STAFF_ID, TUESDAY, type Api, addSessionPlayer, expect, finishedStatus, playSession, startSubmission, test } from './fixtures';

// Attendance is checked on a phone. At 360 px the History pages must show
// whether it worked (Outcome, Status, Result) without swiping the table, and
// the columns folded away for room must still be readable in the first cell.

const PS = 'ps-tuesday';
const PS_LABEL = 'Open play · TCG · Tue 6:00 PM';
const ADDED = '7000001';
const FAILED = '7000002';
const UPSTREAM = '7000009'; // added in play-tools directly
// One unbroken 60-character word: it must break inside the cell, not widen the table.
const LONG_NAME = 'Wolfeschlegelsteinhausenbergerdorffvoralternwarengewissenhaf';
const FAILED_NAME = 'Bea Bravo';
const LONG_ERROR = `play-tools refused this player: ${'the participant could not be recorded for this play session '.repeat(2)}`.slice(0, 120);

test.use({ viewport: { width: 360, height: 780 } });

test.beforeEach(({ fake }) => {
  fake.playSessions = [playSession(PS, '2026-10-13T23:00:00Z')];
  fake.records = new Map([[PS, [fakeRecord(STAFF_ID, { role: 'organizer' }), fakeRecord(UPSTREAM, { first: 'Xan', last: 'Extra' })]]]);
});

/** A partial submission: one added, one failed, the organizer already there as staff, one more only in play-tools. */
async function partialSubmission(api: Api, fake: { dropOnce: Set<string> }): Promise<number> {
  await addSessionPlayer(api, TUESDAY, ADDED, LONG_NAME);
  await addSessionPlayer(api, TUESDAY, FAILED, FAILED_NAME);
  await addSessionPlayer(api, TUESDAY, STAFF_ID, 'Org Anizer');
  fake.dropOnce = new Set([FAILED]);
  const id = await startSubmission(api, TUESDAY, PS);
  expect(await finishedStatus(api, id)).toBe('partial');
  return id;
}

/** No sideways scrolling: not the page, and not inside any table's scroll box. */
async function expectNoSidewaysOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    page: { scroll: document.documentElement.scrollWidth, client: window.innerWidth },
    tables: Array.from(document.querySelectorAll('table'), (t) => ({ scroll: t.parentElement!.scrollWidth, client: t.parentElement!.clientWidth })),
  }));
  expect(widths.page.scroll, 'page scrolls sideways').toBeLessThanOrEqual(widths.page.client);
  for (const t of widths.tables) expect(t.scroll, 'table box scrolls sideways').toBeLessThanOrEqual(t.client);
}

/**
 * Fully on screen from left to right, without swiping the table (the page scrolls down, never sideways).
 * Scrolling it into view would also scroll the table box sideways, hiding exactly what this checks.
 */
async function expectAcrossScreen(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  const width = target.page().viewportSize()!.width;
  expect(box.x, 'starts off the left edge').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'runs off the right edge').toBeLessThanOrEqual(width);
}

const bodyRow =(page: Page, text: string) => page.getByRole('row').filter({ has: page.getByRole('cell') }).filter({ hasText: text });

test.describe('submission detail at 360 px', () => {
  test('shows every outcome on screen, with the player ID under the name', async ({ page, fake, connected }) => {
    const id = await partialSubmission(connected, fake);
    await page.goto(`/history/${id}`);

    await expectAcrossScreen(page.getByRole('columnheader', { name: 'Name' }));
    await expectAcrossScreen(page.getByRole('columnheader', { name: 'Outcome' }));
    await expect(page.getByRole('columnheader', { name: 'Player ID' })).toHaveCount(0);

    const failed = bodyRow(page, FAILED_NAME);
    await expectAcrossScreen(failed.getByText('Failed', { exact: true }));
    await expectAcrossScreen(failed.getByText('Not recorded in play-tools after sending.'));
    await expect(failed.getByRole('cell').first()).toContainText(FAILED);

    const added = bodyRow(page, ADDED);
    await expectAcrossScreen(added.getByText('Added', { exact: true }));
    await expect(added.getByRole('cell').first()).toContainText(LONG_NAME);

    const staff = bodyRow(page, STAFF_ID);
    await expectAcrossScreen(staff.getByText('In play-tools as staff'));
    await expectAcrossScreen(bodyRow(page, UPSTREAM).getByText('Only in play-tools'));

    // Problems first.
    await expect(page.getByRole('row').filter({ has: page.getByRole('cell') }).first()).toContainText(FAILED_NAME);
    await expectNoSidewaysOverflow(page);
  });

  test('wraps a long error and an unnamed player instead of widening the table', async ({ page, fake, connected }) => {
    const id = await partialSubmission(connected, fake);
    await page.route(`**/api/submissions/${id}`, async (route) => {
      const res = await route.fetch();
      const view = (await res.json()) as { items: { playerId: string; displayName: string; error: string | null }[] };
      for (const item of view.items) {
        if (item.playerId === FAILED) item.error = LONG_ERROR;
        if (item.playerId === UPSTREAM) item.displayName = '';
      }
      await route.fulfill({ response: res, json: view });
    });
    await page.goto(`/history/${id}`);

    await expectAcrossScreen(bodyRow(page, FAILED_NAME).getByText(LONG_ERROR));
    const unnamed = bodyRow(page, UPSTREAM);
    await expect(unnamed.getByText('No name')).toBeVisible();
    await expect(unnamed.getByText('Added in play-tools')).toBeVisible();
    await expectNoSidewaysOverflow(page);
  });
});

test.describe('History list at 360 px', () => {
  test('shows status and result on screen, with the play session and start under the date', async ({ page, fake, connected }) => {
    const id = await partialSubmission(connected, fake);
    const undoRes = await connected.request(`/api/submissions/${id}/undo`, { method: 'POST', json: {} });
    expect(undoRes.status, 'start undo').toBe(202);
    const undoId = ((await undoRes.json()) as { submissionId: number }).submissionId;
    expect(await finishedStatus(connected, undoId)).toBe('succeeded');

    await page.goto('/history');
    await expectAcrossScreen(page.getByRole('columnheader', { name: 'Status' }));
    await expectAcrossScreen(page.getByRole('columnheader', { name: 'Result' }));
    await expect(page.getByRole('columnheader', { name: 'Play session' })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Started' })).toHaveCount(0);

    const undoRow = bodyRow(page, `Undo of #${id}`);
    await expectAcrossScreen(undoRow.getByText(`Undo of #${id}`));
    await expectAcrossScreen(undoRow.getByText('Done', { exact: true }));

    const submitRow = bodyRow(page, 'already in play-tools');
    await expectAcrossScreen(submitRow.getByText('Partly done', { exact: true }));
    await expectAcrossScreen(submitRow.getByText(/1 added · 1 already in play-tools · 1 failed · 1 more in play-tools only/));
    const dateCell = submitRow.getByRole('cell').first();
    await expect(dateCell).toContainText(PS_LABEL);
    await expect(dateCell).toContainText(/· organizer/);
    await expectNoSidewaysOverflow(page);

    await submitRow.getByRole('link', { name: TUESDAY }).click();
    await expect(page).toHaveURL(new RegExp(`/history/${id}$`));
    await expect(page.getByRole('row').filter({ has: page.getByRole('cell') }).first()).toContainText(FAILED_NAME);
  });

  test('with nothing submitted, says so without sideways scrolling', async ({ page, api }) => {
    void api; // logged in
    await page.goto('/history');
    await expect(page.getByText('Nothing submitted yet.')).toBeVisible();
    await expectNoSidewaysOverflow(page);
  });

  test('wraps a long cleared-session result on screen', async ({ page, fake, connected }) => {
    await partialSubmission(connected, fake);
    const longLabel = `${PS_LABEL} · Wednesday evening league night at the community centre`;
    await page.route('**/api/submissions', async (route) => {
      const res = await route.fetch();
      const list = (await res.json()) as { submissions: { kind: string; playSessionLabel: string }[] };
      list.submissions[0] = { ...list.submissions[0]!, kind: 'clear', playSessionLabel: longLabel };
      await route.fulfill({ response: res, json: list });
    });
    await page.goto('/history');

    await expectAcrossScreen(bodyRow(page, 'Cleared session').getByText(`Cleared session ${longLabel}`));
    await expectNoSidewaysOverflow(page);
  });
});

test('from 640 px up, both tables keep every column and show each value once', async ({ page, fake, connected }) => {
  const id = await partialSubmission(connected, fake);

  await page.setViewportSize({ width: 639, height: 780 });
  await page.goto('/history');
  await expect(page.getByRole('columnheader')).toHaveText(['Date', 'Status', 'Result']);
  await page.goto(`/history/${id}`);
  await expect(page.getByRole('columnheader')).toHaveText(['Name', 'Outcome']);

  for (const width of [640, 1024]) {
    await page.setViewportSize({ width, height: 780 });
    await page.goto('/history');
    await expect(page.getByRole('columnheader')).toHaveText(['Date', 'Play session', 'Status', 'Result', 'Started']);
    await expect(page.getByText(PS_LABEL, { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expectNoSidewaysOverflow(page);

    await page.goto(`/history/${id}`);
    await expect(page.getByRole('columnheader')).toHaveText(['Name', 'Player ID', 'Outcome']);
    for (const playerId of [ADDED, FAILED]) await expect(page.getByText(playerId, { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expectNoSidewaysOverflow(page);
  }
});
