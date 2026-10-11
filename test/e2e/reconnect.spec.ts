import { fakeRecord } from '../server/fake-pokemon';
import { STAFF_ID, TUESDAY, addSessionPlayer, connectOverApi, expect, loggedInUrl, playSession, test } from './fixtures';

// When Pokémon stops accepting the saved login, nothing is sent: the organizer
// is told where to fix it, the banner stays up until they do, and after the
// paste-back reconnect submitting works again.

const W = '7000001';
const BANNER = 'Pokémon no longer accepts the saved login. Reconnect before submitting attendance.';

test('a refused login stops submission until the organizer reconnects', async ({ page, fake, api }) => {
  fake.playSessions = [playSession('ps-tuesday', '2026-10-13T23:00:00Z')];
  fake.records = new Map([['ps-tuesday', [fakeRecord(STAFF_ID, { role: 'organizer' })]]]);
  // Short-lived access tokens, so the app must refresh on its next use.
  fake.accessTtl = 60;
  await connectOverApi(api);
  await addSessionPlayer(api, TUESDAY, W, 'Wren Walkin');
  fake.revokeChain();
  fake.requests.length = 0;

  await page.goto(`/?date=${TUESDAY}`);
  await page.getByRole('button', { name: 'Submit attendance' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit attendance' });
  await expect(dialog.getByRole('link', { name: 'Open Settings' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();

  await dialog.getByRole('link', { name: 'Open Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  // In-app navigation, no reload: the banner and the Settings card both know.
  await expect(page.getByText(BANNER)).toBeVisible();
  await expect(page.getByText('Needs reconnect', { exact: true })).toBeVisible();
  expect(fake.requests.filter((r) => r.path.includes('/records/')), 'nothing read or sent while disconnected').toEqual([]);

  // Reconnect with the paste-back; the only league is bound again.
  await page.getByRole('button', { name: 'Reconnect' }).click();
  const authorizeUrl = await page.getByRole('link', { name: 'Open Pokémon login' }).getAttribute('href');
  await page.getByLabel('Address of the play-tools tab after logging in').fill(loggedInUrl(new URL(authorizeUrl!).searchParams.get('state')!));
  await page.getByRole('button', { name: 'Finish connecting' }).click();
  await expect(page.getByText(BANNER)).toBeHidden();

  await page.goto(`/?date=${TUESDAY}`);
  await page.getByRole('button', { name: 'Submit attendance' }).click();
  await dialog.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(dialog.getByText('Done', { exact: true })).toBeVisible();
  expect((fake.records.get('ps-tuesday') ?? []).map((r) => r.participant.player_id).sort()).toEqual([STAFF_ID, W].sort());
});
