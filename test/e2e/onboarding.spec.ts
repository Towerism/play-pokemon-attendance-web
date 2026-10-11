import { setupCodeFrom } from '../server/harness';
import { OWNER, TUESDAY, expect, loggedInUrl, test } from './fixtures';

// A fresh install, done once per league: the setup form with the code from
// the log, the paste-back connect, and the league picker. Picking the wrong
// league would send attendance to someone else's league.

test('first run: create the organizer, connect Pokémon, pick the second of two leagues', async ({ page, app, fake }) => {
  fake.leagues = [
    { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true },
    { guid: 'group-2', display_id: 'L6001', display_name: 'Game Store', canSubmit: true },
  ];
  fake.playSessions = [
    {
      guid: 'ps-tuesday',
      type: 'open_play',
      status: 'active',
      start_date: '2026-10-13T23:00:00Z',
      end_date: '2026-10-14T02:00:00Z',
      final_modifiable_datetime: '2099-01-01T00:00:00Z',
      products: ['tcg'],
    },
  ];

  // Setup with the code the server printed.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Set up the organizer account' })).toBeVisible();
  await page.getByLabel('Setup code').fill(setupCodeFrom(app.logs()));
  await page.getByLabel('Username').fill(OWNER.username);
  await page.getByLabel('Password').fill(OWNER.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/$/);

  // Connect: read the state from the login link, never open it, paste the play-tools address back.
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Connect Pokémon account' }).click();
  const authorizeUrl = await page.getByRole('link', { name: 'Open Pokémon login' }).getAttribute('href');
  const state = new URL(authorizeUrl!).searchParams.get('state')!;
  await page.getByLabel('Address of the play-tools tab after logging in').fill(loggedInUrl(state));
  await page.getByRole('button', { name: 'Finish connecting' }).click();

  // Two leagues: nothing is bound until the organizer picks one.
  const leaguePicker = page.getByRole('combobox', { name: 'League' });
  await expect(leaguePicker).toBeVisible();
  await expect(page.getByText('Not chosen yet')).toBeVisible();
  expect(fake.requests.filter((r) => r.form?.grant_type === 'authorization_code')).toHaveLength(1);
  await leaguePicker.click();
  await page.getByRole('option', { name: 'Game Store (L6001)' }).click();
  await page.getByRole('button', { name: 'Save league' }).click();
  await expect(page.getByText('Game Store (L6001)')).toBeVisible();
  await expect(page.getByText('Not chosen yet')).toBeHidden();

  // Submitting now looks for the session in the chosen league only.
  const added = await page.request.post(`/api/sessions/${TUESDAY}/players`, { data: { playerId: '4000001', name: 'Walk In' } });
  expect(added.status()).toBe(201);
  fake.requests.length = 0;
  await page.goto(`/?date=${TUESDAY}`);
  await page.getByRole('button', { name: 'Submit attendance' }).click();
  await expect(page.getByRole('radio', { name: /6:00/ })).toBeVisible();
  const sessionLookups = fake.requests.filter((r) => r.path.endsWith('/play_sessions/')).map((r) => r.path);
  expect(sessionLookups.length).toBeGreaterThan(0);
  expect(sessionLookups.filter((p) => !p.includes('/activity_groups/group-2/')), 'lookups in another league').toEqual([]);
});
