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

// ADR-0008: a second professor connects next to the first, and the organizer
// chooses whose login attendance goes in under. Submitting as the wrong
// professor would put an unintended name on an official record.
test('a second professor: added next to the first, then chosen to submit for the league', async ({ page, fake, connected }) => {
  void connected; // the default professor, already bound to Card Shop
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
  // Brock is in Card Shop too (#75: the league must be one every professor shares), and in Pewter Gym, which Olive isn't.
  const brock = fake.addAccount({
    playerId: '0000222',
    name: 'Brock Harrison',
    leagues: [
      { guid: 'group-3', display_id: 'L7000', display_name: 'Pewter Gym', canSubmit: true },
      { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true },
    ],
  });

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Add Pokémon account' }).click();
  const authorizeUrl = await page.getByRole('link', { name: 'Open Pokémon login' }).getAttribute('href');
  const state = new URL(authorizeUrl!).searchParams.get('state')!;
  await page.getByLabel('Address of the play-tools tab after logging in').fill(loggedInUrl(state, brock.code));
  await page.getByRole('button', { name: 'Finish connecting' }).click();
  await expect(page.getByText('Professor 0000222 added').first()).toBeVisible();

  // Both listed, each with its own actions named for its professor; the first still submits.
  const professors = page.getByRole('list', { name: 'Connected professors' });
  await expect(professors.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Disconnect Professor 0000222' })).toBeVisible();

  // Name him: display only, so the app shows it and Pokémon never sees it.
  await page.getByRole('button', { name: 'Rename Professor 0000222' }).click();
  await page.getByLabel('Display name for Professor 0000222').fill('Brock Harrison');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('button', { name: 'Reconnect Brock Harrison (0000222)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect Brock Harrison (0000222)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect Professor 9999991' })).toBeVisible();
  await expect(professors.getByRole('listitem').filter({ hasText: 'Professor 9999991' })).toContainText('Submits attendance');

  // Choose Brock, then a league both professors share: Pewter Gym, only Brock's, isn't offered.
  await page.getByRole('button', { name: 'Change league' }).click();
  await page.getByRole('combobox', { name: 'Professor who submits attendance' }).click();
  await page.getByRole('option', { name: 'Brock Harrison (0000222)' }).click();
  await page.getByRole('combobox', { name: 'League' }).click();
  await expect(page.getByRole('option')).toHaveText(['Card Shop (L5012)']);
  await page.getByRole('option', { name: 'Card Shop (L5012)' }).click();
  await page.getByRole('button', { name: 'Save league' }).click();
  await expect(professors.getByRole('listitem').filter({ hasText: 'Brock Harrison (0000222)' })).toContainText('Submits attendance');
  await expect(professors.getByRole('listitem').filter({ hasText: 'Professor 9999991' })).not.toContainText('Submits attendance');

  // The submit dialog says who attendance goes in as, and looks up sessions as Brock, in his league.
  const added = await page.request.post(`/api/sessions/${TUESDAY}/players`, { data: { playerId: '4000001', name: 'Walk In' } });
  expect(added.status()).toBe(201);
  expect(fake.requests.filter((r) => JSON.stringify(r).includes('Brock Harrison')), 'naming and choosing Brock sent his name nowhere').toEqual([]);
  fake.requests.length = 0;
  await page.goto(`/?date=${TUESDAY}`);
  await page.getByRole('button', { name: 'Submit attendance' }).click();
  await expect(page.getByRole('radio', { name: /6:00/ })).toBeVisible();
  await expect(page.getByTestId('submit-as')).toHaveText('Submitting as Brock Harrison (0000222)');
  const lookups = fake.requests.filter((r) => r.path.endsWith('/play_sessions/'));
  expect(lookups.length).toBeGreaterThan(0);
  expect(lookups.every((r) => r.as === '0000222' && r.path.includes('/activity_groups/group-1/')), 'every lookup as Brock, in the shared league').toBe(true);
  expect(fake.requests.filter((r) => JSON.stringify(r).includes('Brock Harrison')), 'the display name never reaches Pokémon').toEqual([]);
});

// #75: connected professors can't be from different leagues, so the picker
// offers only leagues they all share, and says so when there is none.
test('the league picker offers nothing to save when the professors share no league', async ({ page, fake, connected }) => {
  void connected; // the default professor, in Card Shop
  const cilan = fake.addAccount({ playerId: '0000333', name: 'Cilan', leagues: [{ guid: 'group-9', display_id: 'L9000', display_name: 'Striaton Café', canSubmit: true }] });
  const start = await connected.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL(((await start.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!;
  expect((await connected.request('/api/pokemon/connect/complete', { method: 'POST', json: { url: loggedInUrl(state, cilan.code) } })).status).toBe(200);

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Change league' }).click();
  await page.getByRole('combobox', { name: 'Professor who submits attendance' }).click();
  await page.getByRole('option', { name: 'Professor 0000333' }).click();
  await expect(page.getByText("These professors share no league in play-tools. Disconnect the one who isn't in your league.")).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'League' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save league' })).toHaveCount(0);
});
