import { TUESDAY, addProfessor, addSessionPlayer, connectAccount, expect, genie, test } from './fixtures';

// Settings → Professors (ADR-0015 §6, §8; architecture §8): inviting with the recipient search, sending by Discord
// through Genie, and removing a professor. The test plays Genie over its HTTP API.

const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };

test('Send by Discord waits for Genie, and a link to copy works without it', async ({ page, connected }) => {
  await addSessionPlayer(connected, TUESDAY, '7000001', 'Wren Walkin');
  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Professors' });
  await card.getByRole('button', { name: 'Invite professor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite a professor' });

  await dialog.getByLabel('Player ID or name').fill('wren');
  const result = dialog.getByRole('button', { name: /Wren Walkin/ });
  await expect(result).toContainText('Player');
  await result.click();
  await expect(dialog.getByRole('button', { name: 'Send by Discord' })).toBeDisabled();
  await expect(dialog.getByTestId('discord-reason')).toHaveText("Genie isn't connected. Copy the link instead.");

  await dialog.getByRole('button', { name: 'Copy link' }).click();
  await expect(dialog.getByLabel('Invite link')).toHaveValue(/\/invite#ppa_inv_/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(card.getByRole('listitem').filter({ hasText: '7000001' })).toContainText('Expires');
});

test.describe('with Genie connected and a site URL', () => {
  test.use({ appEnv: { NUXT_PUBLIC_SITE_URL: 'http://league.example' } });

  test('asks before inviting a roster player on Discord, and says when Genie has no Discord account for them', async ({ page, app, connected }) => {
    await addSessionPlayer(connected, TUESDAY, '7000001', 'Wren Walkin');
    const g = await genie(app, connected);
    await g.poll();

    await page.goto('/settings');
    const card = page.getByRole('region', { name: 'Professors' });
    await card.getByRole('button', { name: 'Invite professor' }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite a professor' });
    await dialog.getByLabel('Player ID or name').fill('wren');
    await dialog.getByRole('button', { name: /Wren Walkin/ }).click();

    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.accept();
    });
    await dialog.getByRole('button', { name: 'Send by Discord' }).click();
    const [message] = await g.poll(10);
    expect(asked).toBe('Wren Walkin (7000001) is on the roster as a player, and players include minors. Send them a professor invite on Discord?');
    expect(message).toMatchObject({ playerId: '7000001', link: { url: expect.stringMatching(/^http:\/\/league\.example\/invite#ppa_inv_/) } });
    await g.report(message!.id, 'no_discord_user');

    await expect(dialog.getByText('Genie has no Discord account linked for Wren Walkin (7000001). Ask them to link it in Genie, or copy the link instead.')).toBeVisible();
    await expect(card.getByRole('listitem').filter({ hasText: '7000001' })).toHaveCount(0);
  });
});

test('the owner removes a professor after a confirm, freeing their place', async ({ page, app, fake, connected }) => {
  void connected;
  const misty = await addProfessor(app, 'misty');
  const account = fake.addAccount({ playerId: '0000333', name: 'Misty', leagues: [CARD_SHOP] });
  expect((await connectAccount(misty, account.code)).status).toBe(200);

  await page.goto('/settings');
  const card = page.getByRole('region', { name: 'Professors' });
  await expect(card.getByText('2 of 10 places used')).toBeVisible();
  const row = card.getByRole('listitem').filter({ hasText: 'misty' });
  await expect(row).toContainText('In the league');

  page.once('dialog', (d) => {
    expect(d.message()).toContain('misty');
    expect(d.message()).toContain('disconnects their Pokémon account');
    void d.accept();
  });
  await card.getByRole('button', { name: 'Remove misty' }).click();

  await expect(row).toHaveCount(0);
  await expect(card.getByText('1 of 10 places used')).toBeVisible();
});
