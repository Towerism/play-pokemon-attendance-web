/** Settings → Professors (ADR-0015 §6, §8): the decisions the card and its dialogs make, kept out of the components. */

export type Membership = 'member' | 'outside' | 'unknown';
export type Delivery = 'sending' | 'delivered' | 'no_discord_user' | 'dm_refused' | 'undeliverable' | 'expired';

/** Someone an invite can be sent to: from the league's players or staff list, or a player ID typed in. */
export interface Recipient {
  playerId: string;
  name: string | null;
  /** On the roster as a player (sighted at a session, or a regular). Players include minors. */
  player: boolean;
  /** The league knows this player ID. */
  known: boolean;
}

const MEMBERSHIP: Record<Membership, string> = { member: 'In the league', outside: 'Not in the league', unknown: 'Checking the league' };
const DELIVERY: Record<Delivery, string> = {
  sending: 'Sending…',
  delivered: 'Sent on Discord',
  no_discord_user: 'No Discord account linked',
  dm_refused: "Doesn't accept DMs from Genie",
  undeliverable: "Couldn't deliver",
  expired: 'Expired before delivery',
};
/** A player ID as the server accepts one (`ProfessorPlayerId`). */
const PLAYER_ID = /^\d{1,12}$/;
const READ_EVERY_MS = 5_000;
const READ_FOR_MS = 120_000;

export const membershipLabel = (m: Membership) => MEMBERSHIP[m];
export const deliveryLabel = (d: Delivery | null) => (d === null ? null : DELIVERY[d]);
export const seatsText = (s: { used: number; max: number }) => `${s.used} of ${s.max} places used`;
export const READ_INTERVAL_MS = READ_EVERY_MS;

export function signInText(lastSignInAt: string | null, format: (iso: string) => string): string {
  return lastSignInAt ? `Last signed in ${format(lastSignInAt)}` : 'Never signed in';
}

export function professorRowLabel(p: { username: string; connection: { playerId: string | null; name: string | null } | null }): string {
  const c = p.connection;
  if (!c || c.playerId === null) return p.username;
  return `${p.username} · ${c.name ? `${c.name} (${c.playerId})` : `Professor ${c.playerId}`}`;
}

export function claimedText(claimedAt: string | null, format: (iso: string) => string): string | null {
  return claimedAt ? `Took over their Pokémon account from you on ${format(claimedAt)}` : null;
}

/**
 * The recipient search's results: known players first, tagged **Player** when sighted or a regular, then staff the
 * roster lacks, then the typed player ID when the league doesn't know it.
 */
export function recipients(
  players: readonly { playerId: string; displayName: string; isRegular: boolean; metrics: unknown }[],
  staff: readonly { playerId: string; name: string | null }[],
  typed: string,
): Recipient[] {
  const out: Recipient[] = players.map((p) => ({ playerId: p.playerId, name: p.displayName, player: p.metrics !== null || p.isRegular, known: true }));
  for (const s of staff) if (!out.some((r) => r.playerId === s.playerId)) out.push({ playerId: s.playerId, name: s.name, player: false, known: true });
  const id = typed.trim();
  if (PLAYER_ID.test(id) && !out.some((r) => r.playerId === id)) out.push({ playerId: id, name: null, player: false, known: false });
  return out;
}

const nameOf = (r: Recipient) => r.name ?? `player ${r.playerId}`;

/** The confirm before a Discord invite to a roster player or an unknown ID; null when none is needed. */
export function recipientConfirm(r: Recipient): string | null {
  if (!r.known) return `This app doesn't know player ${r.playerId}. Send a professor invite to it on Discord?`;
  if (r.player) return `${nameOf(r)} (${r.playerId}) is on the roster as a player, and players include minors. Send them a professor invite on Discord?`;
  return null;
}

export function discordDisabledReason(input: { recipient: Recipient | null; genieAvailable: boolean; siteUrl: string }): string | null {
  if (!input.recipient) return 'Pick who to send it to.';
  if (!input.genieAvailable) return "Genie isn't connected. Copy the link instead.";
  if (!input.siteUrl) return 'Set the site URL (NUXT_PUBLIC_SITE_URL) to send links by Discord.';
  return null;
}

export function resetDiscordDisabled(p: { username: string; connection: { playerId: string | null } | null }): string | null {
  return p.connection?.playerId ? null : `${p.username} has no Pokémon account connected.`;
}

export type SendOutcome = { kind: 'sent' | 'sending' | 'refused'; text: string };

/** What the owner sees after Send by Discord, from the answer's status and `data.code`. */
export function sendOutcome(answer: { status: number; code?: string }, r: Recipient): SendOutcome {
  const name = nameOf(r);
  if (answer.status === 201) return { kind: 'sent', text: `Sent to ${name} on Discord` };
  if (answer.status === 202) return { kind: 'sending', text: `Sending to ${name} on Discord…` };
  if (answer.code === 'no_discord_user') {
    return { kind: 'refused', text: `Genie has no Discord account linked for ${name} (${r.playerId}). Ask them to link it in Genie, or copy the link instead.` };
  }
  if (answer.code === 'dm_refused') return { kind: 'refused', text: `${name} doesn't accept direct messages from Genie.` };
  if (answer.code === 'undeliverable') return { kind: 'refused', text: "Genie couldn't deliver the invite." };
  return { kind: 'refused', text: "Genie isn't connected." };
}

/** The link to copy: the server's, or one on this browser's own address when no site URL is set. */
export function inviteLink(minted: { secret: string; link: string | null }, origin: string): { url: string; localOnly: boolean } {
  return minted.link ? { url: minted.link, localOnly: false } : { url: `${origin}/invite#${minted.secret}`, localOnly: true };
}

/** Whether the card should read the list again: an invite still sending, within 2 minutes of starting to wait. */
export function keepReading(invites: readonly { delivery: Delivery | null }[], startedAt: number, now: number): boolean {
  return invites.some((i) => i.delivery === 'sending') && now - startedAt < READ_FOR_MS;
}
