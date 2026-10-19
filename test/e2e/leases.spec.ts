import { tomTdf } from '../../shared/tdf/__fixtures__/tom';
import { localInstant } from '../../shared/time/local-time';
import { fakeRecord, fakeTournament } from '../server/fake-pokemon';
import { type Api, STAFF_ID, addProfessor, connectAccount, expect, leagueDay, shareSession, test } from './fixtures';

// Tournament leases (ADR-0015 §5; architecture §8): the owner lends tournaments from This week, the lent professor's
// card opens up for them and says who lent it, everyone else's says who may change it, and Settings lists every lease.
// The server's refusals are covered in test/server/leases.test.ts; these journeys check what the pages offer.

const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };
const ORGANIZER = `Professor ${STAFF_ID}`;
const SOON = leagueDay(2);
const YESTERDAY = leagueDay(-1);
const T1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const T2 = 'bbbbbbbb-0000-4000-8000-000000000002';

/** Two of the owner's tournaments on `date`, at 18:00 and 19:00 in the league's time zone. */
function twoTournaments(fake: { tournaments: unknown[]; tournamentRecords: Map<string, unknown[]> }, date: string) {
  for (const [guid, time, name] of [
    [T1, '18:00', 'Olive Cup'],
    [T2, '19:00', 'Olive Challenge'],
  ] as const) {
    const t = fakeTournament(guid.slice(-2), { startsAt: localInstant(date, time, 'America/Chicago').toISOString(), organizer: STAFF_ID, name, displayId: `26-10-9${guid.slice(-5)}` });
    t.guid = guid;
    fake.tournaments.push(t);
    fake.tournamentRecords.set(guid, [fakeRecord(STAFF_ID, { role: 'organizer', first: 'Olive', last: 'Organizer' })]);
  }
}

/** A member professor connected in Card Shop. */
async function member(app: Parameters<typeof addProfessor>[0], fake: { addAccount: (a: { playerId: string; name: string; leagues: unknown[] }) => { code: string } }, username: string, playerId: string) {
  const api = await addProfessor(app, username);
  expect((await connectAccount(api, fake.addAccount({ playerId, name: username, leagues: [CARD_SHOP] }).code)).status).toBe(200);
  return api;
}

/** The owner lends `tournamentIds` to the member called `username`, over the API. */
async function lend(owner: Api, tournamentIds: string[], username: string) {
  const { lessees } = (await (await owner.request('/api/tournament-leases')).json()) as { lessees: { userId: number; username: string }[] };
  const res = await owner.request('/api/tournament-leases', { method: 'POST', json: { tournamentIds, lesseeUserId: lessees.find((l) => l.username === username)!.userId } });
  expect(res.status, 'lend').toBe(201);
}

test('the owner lends two tournaments from This week to a member professor', async ({ page, app, fake, connected }) => {
  void connected;
  twoTournaments(fake, SOON);
  await member(app, fake, 'misty', '0000333');

  await page.goto(`/?date=${SOON}`);
  const cup = page.getByRole('region', { name: /Olive Cup/ });
  await cup.getByRole('button', { name: /^Lend… Olive Cup/ }).click();

  const dialog = page.getByRole('dialog', { name: 'Lend tournaments' });
  await dialog.getByRole('combobox', { name: 'Lend to' }).click();
  await page.getByRole('option', { name: 'misty' }).click();
  await dialog.getByRole('checkbox', { name: /Olive Challenge/ }).check();
  const lent = page.waitForResponse((r) => r.url().endsWith('/api/tournament-leases') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Lend' }).click();
  expect((await lent).status()).toBe(201);

  await expect(page.getByText('Lent 2 tournaments to misty')).toBeVisible();
  for (const name of [/Olive Cup/, /Olive Challenge/]) {
    const card = page.getByRole('region', { name });
    await expect(card.getByText(/^Lent to misty until /)).toBeVisible();
    await expect(card.getByRole('button', { name: /^End lease on/ })).toBeVisible();
  }
});

test('a lent card opens up for its professor and stays read-only for everyone else', async ({ page, context, app, fake, connected }) => {
  twoTournaments(fake, SOON);
  const misty = await member(app, fake, 'misty', '0000333');
  const brock = await member(app, fake, 'brock', '0000444');
  await lend(connected, [T1], 'misty');

  await test.step('the lent professor', async () => {
    await context.clearCookies();
    await shareSession(context, app, misty);
    await page.goto(`/?date=${SOON}`);
    const card = page.getByRole('region', { name: /Olive Cup/ });
    await expect(card.getByText(new RegExp(`^Lent to you by ${ORGANIZER} until `))).toBeVisible();
    await expect(card.getByRole('combobox', { name: /Find staff for Olive Cup/ }).or(card.getByRole('textbox', { name: /Find staff for Olive Cup/ }))).toBeVisible();
    await expect(card.getByRole('button', { name: /^Give back/ })).toBeVisible();
    // The other tournament isn't lent: it stays the owner's.
    await expect(page.getByRole('region', { name: /Olive Challenge/ })).toContainText(`Only ${ORGANIZER} can change this`);
  });

  await test.step('another member', async () => {
    await context.clearCookies();
    await shareSession(context, app, brock);
    await page.goto(`/?date=${SOON}`);
    const card = page.getByRole('region', { name: /Olive Cup/ });
    await expect(card).toContainText(`Only ${ORGANIZER} or misty can change this`);
    await expect(card.getByRole('combobox', { name: /Find staff/ }).or(card.getByRole('textbox', { name: /Find staff/ }))).toHaveCount(0);
    await expect(card.getByRole('button', { name: /Give back|End lease|Lend…/ })).toHaveCount(0);
  });
});

test("the lent professor is asked to have the organizer set their full name, and can't send without it", async ({ page, context, app, fake, connected }) => {
  twoTournaments(fake, YESTERDAY);
  const misty = await member(app, fake, 'misty', '0000333');
  await lend(connected, [T1], 'misty');
  await context.clearCookies();
  await shareSession(context, app, misty);

  await page.goto(`/?date=${YESTERDAY}`);
  const card = page.getByRole('region', { name: /Olive Cup/ });
  const content = tomTdf({
    players: [{ userid: '1234567', first: 'Ash', last: 'Ketchum' }],
    idElement: '<id>26-10-900001</id>',
    organizerElement: '<organizer popid="1230000" name="Someone Else"/>',
  });
  await card.locator('input[type="file"]').setInputFiles({ name: 'cup.tdf', mimeType: 'application/xml', buffer: Buffer.from(content) });

  const dialog = page.getByRole('dialog', { name: 'Upload results' });
  await expect(dialog.getByText(`Ask ${ORGANIZER} to set their full name for TDFs in Settings.`)).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /full name/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Upload|Save name/ })).toHaveCount(0);
});

test('Settings lists every live lease for the owner, with End lease only on their own', async ({ page, app, fake, connected }) => {
  twoTournaments(fake, SOON);
  await member(app, fake, 'misty', '0000333');
  await lend(connected, [T1], 'misty');

  await page.goto('/settings');
  const professors = page.getByRole('heading', { name: 'Lent tournaments' }).locator('..');
  await expect(professors).toContainText('Olive Cup');
  await expect(professors).toContainText(`${ORGANIZER} lent it to misty until`);
  await expect(professors.getByRole('button', { name: /^End lease on Olive Cup/ })).toBeVisible();
});
