/**
 * The fixed texts the accounts module sends through the Discord channel (ADR-0015 §7). No route takes message text,
 * so these templates are the only words that reach Genie from here.
 */

export interface MessageText {
  text: string;
  linkLabel: string;
}

/** Removes Discord mention syntax from a name placed in a text, so it can't ping anyone even if Genie's guard failed. */
export function withoutMentions(name: string): string {
  return name.replace(/<(?:@[!&]?|#)\d+>/g, '').replaceAll('@', '');
}

/** "Thu, Oct 22, 2:05 PM", in the league's time zone. */
function until(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
}

export function inviteMessage(input: { owner: string; leagueName: string | null; expiresAt: Date; timeZone: string }): MessageText {
  const league = input.leagueName === null ? 'your league' : withoutMentions(input.leagueName);
  return {
    text: `${withoutMentions(input.owner)} invited you to help run ${league} on Play! Pokémon Attendance. The link works once, until ${until(input.expiresAt, input.timeZone)}.`,
    linkLabel: 'Accept the invite',
  };
}

export function resetMessage(input: { owner: string; username: string; expiresAt: Date; timeZone: string }): MessageText {
  return {
    text: `${withoutMentions(input.owner)} sent you a link to set a new password for ${withoutMentions(input.username)} on Play! Pokémon Attendance. It works once, until ${until(input.expiresAt, input.timeZone)}.`,
    linkLabel: 'Set a new password',
  };
}
