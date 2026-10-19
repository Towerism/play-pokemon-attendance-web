import { describe, expect, it } from 'vitest';
import {
  claimedText,
  deliveryLabel,
  discordDisabledReason,
  inviteLink,
  keepReading,
  membershipLabel,
  professorRowLabel,
  recipientConfirm,
  recipients,
  resetDiscordDisabled,
  seatsText,
  sendOutcome,
  signInText,
} from './professors';

const fmt = (iso: string) => `<${iso}>`;

describe('labels on the Professors card', () => {
  it('name each membership state', () => {
    expect(membershipLabel('member')).toBe('In the league');
    expect(membershipLabel('outside')).toBe('Not in the league');
    expect(membershipLabel('unknown')).toBe('Checking the league');
  });

  it('name each Discord delivery state, and nothing for a copied link', () => {
    expect(deliveryLabel('sending')).toBe('Sending…');
    expect(deliveryLabel('delivered')).toBe('Sent on Discord');
    expect(deliveryLabel('no_discord_user')).toBe('No Discord account linked');
    expect(deliveryLabel('dm_refused')).toBe("Doesn't accept DMs from Genie");
    expect(deliveryLabel('undeliverable')).toBe("Couldn't deliver");
    expect(deliveryLabel('expired')).toBe('Expired before delivery');
    expect(deliveryLabel(null)).toBeNull();
  });

  it('say when a professor last signed in', () => {
    expect(signInText('2026-10-19T12:00:00.000Z', fmt)).toBe('Last signed in <2026-10-19T12:00:00.000Z>');
    expect(signInText(null, fmt)).toBe('Never signed in');
  });

  it('count the places used', () => {
    expect(seatsText({ used: 4, max: 10 })).toBe('4 of 10 places used');
  });

  it("name a professor with their connection, and say when they took it over from the owner", () => {
    expect(professorRowLabel({ username: 'misty', connection: { playerId: '0000333', name: 'Misty' } })).toBe('misty · Misty (0000333)');
    expect(professorRowLabel({ username: 'misty', connection: { playerId: '0000333', name: null } })).toBe('misty · Professor 0000333');
    expect(professorRowLabel({ username: 'misty', connection: null })).toBe('misty');
    expect(claimedText('2026-10-19T12:00:00.000Z', fmt)).toBe('Took over their Pokémon account from you on <2026-10-19T12:00:00.000Z>');
    expect(claimedText(null, fmt)).toBeNull();
  });
});

describe('recipients (the invite dialog’s search)', () => {
  const players = [
    { playerId: '0000111', displayName: 'Wren Walkin', isRegular: false, metrics: { sightingsTotal: 3 } },
    { playerId: '0000222', displayName: 'Rae Regular', isRegular: true, metrics: null },
    { playerId: '0000333', displayName: 'Misty', isRegular: false, metrics: null },
  ];
  const staff = [
    { playerId: '0000333', name: 'Misty' },
    { playerId: '0000444', name: 'Brock' },
  ];

  it('tags people sighted or regular as players, and lists staff the roster lacks once', () => {
    expect(recipients(players, staff, 'mi')).toEqual([
      { playerId: '0000111', name: 'Wren Walkin', player: true, known: true },
      { playerId: '0000222', name: 'Rae Regular', player: true, known: true },
      { playerId: '0000333', name: 'Misty', player: false, known: true },
      { playerId: '0000444', name: 'Brock', player: false, known: true },
    ]);
  });

  it('offers a typed player ID the league does not know', () => {
    expect(recipients([], [], ' 0099999 ')).toEqual([{ playerId: '0099999', name: null, player: false, known: false }]);
    expect(recipients(players, staff, '0000333').filter((r) => !r.known)).toEqual([]);
    expect(recipients([], [], 'abc')).toEqual([]);
  });

  it('asks before sending a Discord invite to a roster player or an unknown ID, and not to staff', () => {
    expect(recipientConfirm({ playerId: '0000111', name: 'Wren Walkin', player: true, known: true })).toBe(
      'Wren Walkin (0000111) is on the roster as a player, and players include minors. Send them a professor invite on Discord?',
    );
    expect(recipientConfirm({ playerId: '0099999', name: null, player: false, known: false })).toBe(
      "This app doesn't know player 0099999. Send a professor invite to it on Discord?",
    );
    expect(recipientConfirm({ playerId: '0000444', name: 'Brock', player: false, known: true })).toBeNull();
  });
});

describe('Send by Discord', () => {
  const recipient = { playerId: '0000444', name: 'Brock', player: false, known: true };

  it('says why it is disabled: no recipient, Genie not connected, or no site URL', () => {
    expect(discordDisabledReason({ recipient: null, genieAvailable: true, siteUrl: 'https://x' })).toBe('Pick who to send it to.');
    expect(discordDisabledReason({ recipient, genieAvailable: false, siteUrl: 'https://x' })).toBe("Genie isn't connected. Copy the link instead.");
    expect(discordDisabledReason({ recipient, genieAvailable: true, siteUrl: '' })).toBe('Set the site URL (NUXT_PUBLIC_SITE_URL) to send links by Discord.');
    expect(discordDisabledReason({ recipient, genieAvailable: true, siteUrl: 'https://x' })).toBeNull();
  });

  it('turns each answer into what the owner sees', () => {
    expect(sendOutcome({ status: 201 }, recipient)).toEqual({ kind: 'sent', text: 'Sent to Brock on Discord' });
    expect(sendOutcome({ status: 202 }, recipient)).toEqual({ kind: 'sending', text: 'Sending to Brock on Discord…' });
    expect(sendOutcome({ status: 422, code: 'no_discord_user' }, recipient)).toEqual({
      kind: 'refused',
      text: 'Genie has no Discord account linked for Brock (0000444). Ask them to link it in Genie, or copy the link instead.',
    });
    expect(sendOutcome({ status: 422, code: 'dm_refused' }, recipient)).toEqual({ kind: 'refused', text: "Brock doesn't accept direct messages from Genie." });
    expect(sendOutcome({ status: 422, code: 'undeliverable' }, recipient)).toEqual({ kind: 'refused', text: "Genie couldn't deliver the invite." });
    expect(sendOutcome({ status: 503, code: 'genie_unavailable' }, recipient)).toEqual({ kind: 'refused', text: "Genie isn't connected." });
    expect(sendOutcome({ status: 422, code: 'no_discord_user' }, { playerId: '0099999', name: null, player: false, known: false }).text).toContain(
      'for player 0099999 (0099999)',
    );
  });

  it("is disabled for a reset of a professor with no connection", () => {
    expect(resetDiscordDisabled({ username: 'misty', connection: null })).toBe('misty has no Pokémon account connected.');
    expect(resetDiscordDisabled({ username: 'misty', connection: { playerId: null, name: null } })).toBe('misty has no Pokémon account connected.');
    expect(resetDiscordDisabled({ username: 'misty', connection: { playerId: '0000333', name: null } })).toBeNull();
  });
});

describe('copied links', () => {
  it("use the server's link, or this browser's own address without a site URL", () => {
    expect(inviteLink({ secret: 'ppa_inv_x', link: 'https://league.example/invite#ppa_inv_x' }, 'http://192.168.1.5:3000')).toEqual({
      url: 'https://league.example/invite#ppa_inv_x',
      localOnly: false,
    });
    expect(inviteLink({ secret: 'ppa_inv_x', link: null }, 'http://192.168.1.5:3000')).toEqual({ url: 'http://192.168.1.5:3000/invite#ppa_inv_x', localOnly: true });
  });
});

describe('keepReading (while an invite is still sending)', () => {
  it('reads again every 5 seconds while one shows Sending…, for at most 2 minutes', () => {
    const sending = [{ delivery: 'sending' as const }];
    expect(keepReading(sending, 0, 119_999)).toBe(true);
    expect(keepReading(sending, 0, 120_000)).toBe(false);
    expect(keepReading([{ delivery: 'delivered' as const }, { delivery: null }], 0, 1)).toBe(false);
  });
});
