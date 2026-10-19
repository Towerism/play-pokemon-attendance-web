import { fakeRecord, fakeTournament } from '../server/fake-pokemon';
import { STAFF_ID, TUESDAY, addProfessor, addSessionPlayer, connectAccount, expect, finishedStatus, playSession, shareSession, startSubmission, test } from './fixtures';

// What a professor sees (ADR-0015 §3, §4, §8; architecture §8). No professor can be invited until #202, so each journey
// adds one straight to the database. The server refuses every action these pages hide; these journeys check that the
// pages don't offer them, and say why.

const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };
const MISTY_ID = '0000333';
/** Tuesday 19:30 in the league's timezone (America/Chicago). */
const TUESDAY_EVENING = '2026-10-14T00:30:00Z';

test('a professor not yet in the league sees only Settings, saying why', async ({ page, context, app, connected }) => {
  void connected; // the owner's account, bound to Card Shop
  const misty = await addProfessor(app, 'misty');
  await context.clearCookies();
  await shareSession(context, app, misty);

  await page.goto('/tournaments');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('waiting')).toHaveText('Connect your Pokémon account to use the league.');
  await expect(page.getByRole('button', { name: 'Connect Pokémon account' })).toBeVisible();
  // Phone width: the links are in the menu drawer.
  await page.getByRole('button', { name: 'Open menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu.getByRole('link')).toHaveText(['Settings']);
  await page.getByRole('button', { name: 'Close menu' }).click();
  await expect(page.getByRole('heading', { name: 'Curation thresholds' })).toHaveCount(0);
});

test("a member professor sees the owner's work read-only, and none of the owner's settings", async ({ page, context, app, fake, connected }) => {
  fake.playSessions = [playSession('ps-tuesday', '2026-10-13T23:00:00Z')];
  fake.records = new Map([['ps-tuesday', [fakeRecord(STAFF_ID, { role: 'organizer' })]]]);
  fake.tournaments.push(fakeTournament('olives-cup', { startsAt: TUESDAY_EVENING, organizer: STAFF_ID, name: 'Olive Cup' }));
  fake.tournamentRecords.set('olives-cup', [fakeRecord(STAFF_ID, { role: 'organizer', first: 'Olive', last: 'Organizer', guid: 'rec-org' })]);
  // The owner submits once, so History has an attempt that ran as the owner's connection.
  await addSessionPlayer(connected, TUESDAY, '7000001', 'Wren Walkin');
  expect(await finishedStatus(connected, await startSubmission(connected, TUESDAY, 'ps-tuesday'))).toBe('succeeded');

  const account = fake.addAccount({ playerId: MISTY_ID, name: 'Misty', leagues: [CARD_SHOP] });
  const misty = await addProfessor(app, 'misty');
  expect((await connectAccount(misty, account.code)).status).toBe(200);
  await context.clearCookies();
  await shareSession(context, app, misty);

  await test.step('Settings: only her own account, no owner cards', async () => {
    await page.goto('/settings');
    const professors = page.getByRole('list', { name: 'Connected professors' });
    await expect(professors.getByRole('listitem')).toHaveCount(1);
    await expect(professors.getByRole('listitem')).toContainText(`Professor ${MISTY_ID}`);
    await expect(page.getByRole('button', { name: `Disconnect Professor ${MISTY_ID}` })).toBeVisible();
    await expect(page.getByRole('button', { name: /Change league|Choose league/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Add Pokémon account|Connect Pokémon account/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Curation thresholds' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Integrations' })).toHaveCount(0);
  });

  await test.step("This week: the owner's tournament is read-only, and there is no Clear session", async () => {
    await page.goto(`/?date=${TUESDAY}`);
    const card = page.getByRole('region', { name: 'Olive Cup' });
    await expect(card).toContainText(`Only Professor ${STAFF_ID} can change this`);
    await expect(card.getByRole('button', { name: /Assign staff/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear session…' })).toHaveCount(0);
  });

  await test.step("History: the owner's submission can't be undone by her", async () => {
    await page.goto('/history');
    await page.getByRole('link').filter({ hasText: TUESDAY }).first().click();
    await expect(page.getByTestId('locked')).toHaveText(`Only Professor ${STAFF_ID} can change this`);
    await expect(page.getByRole('button', { name: 'Remove players added by this submission' })).toHaveCount(0);
  });
});

test("a professor who logs into the account the owner connected for them takes it over, and is told to change its password", async ({
  page,
  context,
  app,
  fake,
  connected,
}) => {
  const account = fake.addAccount({ playerId: MISTY_ID, name: 'Misty', leagues: [CARD_SHOP] });
  expect((await connectAccount(connected, account.code)).status).toBe(200);
  const misty = await addProfessor(app, 'misty');
  await context.clearCookies();
  await shareSession(context, app, misty);

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Connect Pokémon account' }).click();
  const authorizeUrl = await page.getByRole('link', { name: 'Open Pokémon login' }).getAttribute('href');
  const state = new URL(authorizeUrl!).searchParams.get('state')!;
  await page.getByLabel('Address of the play-tools tab after logging in').fill(`https://play-tools.pokemon.com/loggedIn?code=${account.code}&state=${state}`);
  await page.getByRole('button', { name: 'Finish connecting' }).click();

  await expect(page.getByTestId('claimed')).toContainText(`Professor ${MISTY_ID} is yours now.`);
  await expect(page.getByTestId('claimed')).toContainText('Change its Pokémon password');
  await expect(page.getByRole('list', { name: 'Connected professors' }).getByRole('listitem')).toHaveCount(1);
});
