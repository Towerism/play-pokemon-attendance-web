import { fakeRecord } from '../server/fake-pokemon';
import { STAFF_ID, TUESDAY, addSessionPlayer, connectOverApi, expect, loggedInUrl, playSession, test } from './fixtures';

// When Pokémon stops accepting the submitting professor's login, nothing is
// sent: the organizer is told where to fix it, the banner (naming that
// professor) stays up until they do, and after the paste-back reconnect
// submitting works again. Another professor's dead login only shows on their
// Settings row (ADR-0008).

const W = '7000001';
const PROFESSOR = 'Professor 9999991';
const BANNER = `Pokémon no longer accepts ${PROFESSOR}’s login. Reconnect before submitting attendance.`;

test('a refused login stops submission until the organizer reconnects; only the submitting professor raises the banner', async ({ page, fake, api }) => {
  fake.playSessions = [playSession('ps-tuesday', '2026-10-13T23:00:00Z')];
  fake.records = new Map([['ps-tuesday', [fakeRecord(STAFF_ID, { role: 'organizer' })]]]);
  // Short-lived access tokens, so the app must refresh on its next use.
  fake.accessTtl = 60;
  await connectOverApi(api);
  const brock = fake.addAccount({ playerId: '0000222', name: 'Brock Harrison' });
  const start = await api.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL(((await start.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!;
  expect((await api.request('/api/pokemon/connect/complete', { method: 'POST', json: { url: loggedInUrl(state, brock.code) } })).status).toBe(200);
  await addSessionPlayer(api, TUESDAY, W, 'Wren Walkin');

  // Brock (not submitting) loses his login: his row says so, the banner stays hidden.
  fake.revokeChain('0000222');
  expect((await api.request('/api/leagues/upstream?professor=0000222')).status).toBe(409);
  await page.goto('/settings');
  const brockRow = page.getByRole('list', { name: 'Connected professors' }).getByRole('listitem').filter({ hasText: 'Professor 0000222' });
  await expect(brockRow).toContainText('Needs reconnect');
  await expect(page.getByText(/no longer accepts .*login\. Reconnect before submitting/)).toBeHidden();

  // The submitting professor loses theirs.
  fake.revokeChain();
  fake.requests.length = 0;
  await page.goto(`/?date=${TUESDAY}`);
  await page.getByRole('button', { name: 'Submit attendance' }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit attendance' });
  await expect(dialog.getByRole('link', { name: 'Open Settings' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();

  await dialog.getByRole('link', { name: 'Open Settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  // In-app navigation, no reload: the banner and the Settings row both know, naming the professor.
  await expect(page.getByText(BANNER)).toBeVisible();
  const ownRow = page.getByRole('list', { name: 'Connected professors' }).getByRole('listitem').filter({ hasText: PROFESSOR });
  await expect(ownRow).toContainText('Needs reconnect');
  expect(fake.requests.filter((r) => r.path.includes('/records/')), 'nothing read or sent while disconnected').toEqual([]);

  // Reconnect that professor with the paste-back; the league stays bound to them.
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
