import { dateIn } from '../../shared/time/local-time';

// Settings → Calendar (ADR-0016 §6): the words the card shows about a feed link, kept here so they're tested.

/** Where a new feed link works, as the server decides it from the app's addresses. */
export type CalendarReach = 'internet' | 'site_url' | 'local_only';

export function reachText(reach: CalendarReach): string {
  if (reach === 'internet') return 'Works with Google Calendar (From URL), iCloud, Outlook.com and calendar apps on your devices.';
  if (reach === 'site_url') {
    return "Works with Google Calendar, iCloud and Outlook.com if this app's address is reachable from the internet. A Tailscale or home-network address isn't; then it works only in calendar apps on devices on that network.";
  }
  return 'Works only in calendar apps that fetch it from your device (macOS "On My Mac" calendars, classic Outlook desktop) on a network that reaches this app. Google Calendar, iCloud and Outlook.com can\'t reach it.';
}

/** A source whose events the feeds can't confirm: a professor by name, or the play sessions. */
export function staleText(source: { name: string | null; lastReadAt: string | null }, timeZone: string): string {
  const who = source.name ?? 'Play sessions';
  return source.lastReadAt ? `${who}: not confirmed since ${dateIn(new Date(source.lastReadAt), timeZone)}` : `${who}: never read`;
}

/** The confirmation before a change that cuts subscribers off. */
export function confirmText(kind: 'public' | 'user', action: 'rotate' | 'off'): string {
  const feed = kind === 'public' ? 'the public feed' : 'your feed';
  if (action === 'off') return `Turn off ${feed}? Calendars subscribed to it stop getting updates.`;
  const who = kind === 'public' ? 'Everyone subscribed with the old link stops' : 'Calendars subscribed with the old link stop';
  return `Make a new link for ${feed}? ${who} getting updates until they subscribe again.`;
}
