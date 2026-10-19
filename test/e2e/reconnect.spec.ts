import { fakeRecord } from '../server/fake-pokemon';
import { STAFF_ID, TUESDAY, addSessionPlayer, connectOverApi, expect, loggedInUrl, playSession, test } from './fixtures';

// When Pokémon stops accepting the viewer's login, nothing is sent: they are told where to fix it, the banner (naming
// that login) stays up until they do, and after the paste-back reconnect submitting works again. The banner follows the
// viewer's own logins only (ADR-0015 §4); another professor's dead login is theirs to fix.

const W = '7000001';
const PROFESSOR = 'Professor 9999991';
const BANNER = `Pokémon no longer accepts ${PROFESSOR}’s login. Reconnect it in Settings.`;

test('a refused login stops submission until the organizer reconnects, and the banner names it', async ({ page, fake, api }) => {
  fake.playSessions = [playSession('ps-tuesday', '2026-10-13T23:00:00Z')];
  fake.records = new Map([['ps-tuesday', [fakeRecord(STAFF_ID, { role: 'organizer' })]]]);
  // Short-lived access tokens, so the app must refresh on its next use.
  fake.accessTtl = 60;
  await connectOverApi(api);
  await addSessionPlayer(api, TUESDAY, W, 'Wren Walkin');

  // The organizer's only login is refused.
  fake.revokeChain();
  fake.requests.length = 0;
  await page.goto(`/?date=${TUESDAY}`);
  await page.getByRole('button', { name: 'Submit attendance' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit attendance' });
  await expect(dialog.getByRole('link', { name: 'Open Settings' }).first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();

  await dialog.getByRole('link', { name: 'Open Settings' }).first().click();
  await expect(page).toHaveURL(/\/settings$/);
  // In-app navigation, no reload: the banner and the Settings row both know, naming the professor.
  await expect(page.getByText(BANNER)).toBeVisible();
  const ownRow = page.getByRole('list', { name: 'Connected professors' }).getByRole('listitem').filter({ hasText: PROFESSOR });
  await expect(ownRow).toContainText('Needs reconnect');
  expect(fake.requests.filter((r) => r.path.includes('/records/')), 'nothing read or sent while disconnected').toEqual([]);

  // Reconnect it with the paste-back; the league stays chosen.
  await page.getByRole('button', { name: `Reconnect ${PROFESSOR}` }).click();
  const authorizeUrl = await page.getByRole('link', { name: 'Open Pokémon login' }).getAttribute('href');
  await page.getByLabel('Address of the play-tools tab after logging in').fill(loggedInUrl(new URL(authorizeUrl!).searchParams.get('state')!));
  await page.getByRole('button', { name: 'Finish connecting' }).click();
  await expect(page.getByText(`${PROFESSOR} reconnected`).first()).toBeVisible();
  await expect(page.getByText(BANNER)).toBeHidden();

  await page.goto(`/?date=${TUESDAY}`);
  await page.getByRole('button', { name: 'Submit attendance' }).click();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog.getByText('Done', { exact: true })).toBeVisible();
  expect((fake.records.get('ps-tuesday') ?? []).map((r) => r.participant.player_id).sort()).toEqual([STAFF_ID, W].sort());
});
