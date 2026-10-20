import { describe, expect, it } from 'vitest';
import { confirmText, reachText, staleText } from './calendar';

describe('reachText', () => {
  it('says where a new link works, from how the app is reached', () => {
    expect(reachText('internet')).toBe('Works with Google Calendar (From URL), iCloud, Outlook.com and calendar apps on your devices.');
    expect(reachText('site_url')).toBe(
      "Works with Google Calendar, iCloud and Outlook.com if this app's address is reachable from the internet. A Tailscale or home-network address isn't; then it works only in calendar apps on devices on that network.",
    );
    expect(reachText('local_only')).toBe(
      'Works only in calendar apps that fetch it from your device (macOS "On My Mac" calendars, classic Outlook desktop) on a network that reaches this app. Google Calendar, iCloud and Outlook.com can\'t reach it.',
    );
  });
});

describe('staleText', () => {
  it("names the source and the date its events were last confirmed, in the league's time zone", () => {
    const tz = 'America/Chicago';
    expect(staleText({ key: 'professor:0011111', name: 'Misty', since: '2026-10-01T18:00:00.000Z' }, tz)).toBe('Misty: not confirmed since 2026-10-01');
    expect(staleText({ key: 'sessions', name: null, since: '2026-10-02T03:00:00.000Z' }, tz)).toBe('Play sessions: not confirmed since 2026-10-01');
    expect(staleText({ key: 'professor:0022222', name: null, since: '2026-10-02T03:00:00.000Z' }, tz)).toBe(
      'Professor 0022222: not confirmed since 2026-10-01',
    );
    expect(staleText({ key: 'professor:0022222', name: 'Brock', since: null }, tz)).toBe('Brock: never read');
  });
});

describe('confirmText', () => {
  it('warns that subscribers lose the feed when its link is rotated or the feed is turned off', () => {
    expect(confirmText('public', 'rotate')).toBe(
      'Make a new link for the public feed? Everyone subscribed with the old link stops getting updates until they subscribe again.',
    );
    expect(confirmText('user', 'off')).toBe('Turn off your feed? Calendars subscribed to it stop getting updates.');
    expect(confirmText('public', 'off')).toBe('Turn off the public feed? Calendars subscribed to it stop getting updates.');
    expect(confirmText('user', 'rotate')).toBe('Make a new link for your feed? Calendars subscribed with the old link stop getting updates until they subscribe again.');
  });
});
