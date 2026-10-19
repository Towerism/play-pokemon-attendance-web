import { describe, expect, it } from 'vitest';
import { inviteMessage, resetMessage } from './messages';

const EXPIRES = new Date('2026-10-22T19:05:00Z');
const TZ = 'America/Chicago';

describe('inviteMessage', () => {
  it('names who invited them, the league and when the link stops working, in the league time zone', () => {
    expect(inviteMessage({ owner: 'organizer', leagueName: 'Card Shop', expiresAt: EXPIRES, timeZone: TZ })).toEqual({
      text: 'organizer invited you to help run Card Shop on Play! Pokémon Attendance. The link works once, until Thu, Oct 22, 2:05 PM.',
      linkLabel: 'Accept the invite',
    });
  });

  it('says "your league" before a league is chosen, and strips mentions from the league name', () => {
    expect(inviteMessage({ owner: 'organizer', leagueName: null, expiresAt: EXPIRES, timeZone: TZ }).text).toContain('help run your league on');
    const text = inviteMessage({ owner: 'organizer', leagueName: 'Card <@123> Shop @everyone', expiresAt: EXPIRES, timeZone: TZ }).text;
    expect(text).toContain('help run Card  Shop everyone on');
    expect(text).not.toContain('@');
  });
});

describe('resetMessage', () => {
  it('names the account whose password the link sets', () => {
    expect(resetMessage({ owner: 'organizer', username: 'misty', expiresAt: EXPIRES, timeZone: TZ })).toEqual({
      text: 'organizer sent you a link to set a new password for misty on Play! Pokémon Attendance. It works once, until Thu, Oct 22, 2:05 PM.',
      linkLabel: 'Set a new password',
    });
  });
});
