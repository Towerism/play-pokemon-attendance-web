import { describe, expect, it } from 'vitest';
import { lastDayLabel, latestEndDate, leaseEndsAt, leaseLine, noticeLine, shouldPollLeases } from './leases';

const ZONE = 'America/Chicago';
const LEASE = { id: 7, lesseeUserId: 2, lesseeName: 'Misty', organizerName: 'Prof Oak', endsAt: '2026-11-15T06:00:00.000Z' };

describe('lastDayLabel', () => {
  it('names the last day a lease covers, in the given time zone', () => {
    expect(lastDayLabel(LEASE.endsAt, ZONE)).toBe('Sat, Nov 14');
  });
});

describe('leaseLine', () => {
  it('tells the organizer who has it, offering End lease', () => {
    expect(leaseLine(LEASE, 1, true, ZONE)).toEqual({ kind: 'organizer', leaseId: 7, text: 'Lent to Misty until Sat, Nov 14' });
  });

  it('tells the lent professor who lent it to them, offering Give back', () => {
    expect(leaseLine(LEASE, 2, false, ZONE)).toEqual({ kind: 'lessee', leaseId: 7, text: 'Lent to you by Prof Oak until Sat, Nov 14' });
  });

  it('tells everyone else who can change it', () => {
    expect(leaseLine(LEASE, 3, false, ZONE)).toEqual({ kind: 'other', leaseId: 7, text: 'Only Prof Oak or Misty can change this' });
  });

  it('says nothing without a lease', () => {
    expect(leaseLine(null, 1, true, ZONE)).toBeNull();
    expect(leaseLine(undefined, 1, true, ZONE)).toBeNull();
  });
});

describe('noticeLine', () => {
  it.each([
    ['delivered', 'Notice sent'],
    ['sending', 'Sending notice…'],
    ['no_discord_user', 'No Discord account linked for Misty; notice not sent'],
    ['dm_refused', "Misty doesn't accept DMs from Genie; notice not sent"],
    ['undeliverable', "Genie couldn't deliver the notice"],
    ['expired', "Genie couldn't deliver the notice"],
    ['genie_unavailable', "Genie isn't connected; no notice sent"],
    ['no_recipient', 'Misty has no Pokémon account connected; no notice sent'],
  ] as const)('reads %s as "%s"', (state, line) => {
    expect(noticeLine(state, 'Misty')).toBe(line);
  });

  it('says nothing when no notice applies', () => {
    expect(noticeLine(null, 'Misty')).toBeNull();
  });
});

describe('the end date a lease may have', () => {
  it('sends a picked date as the end of that day in the league time zone', () => {
    expect(leaseEndsAt('2026-11-14', ZONE)).toBe('2026-11-15T06:00:00.000Z');
  });

  it('allows up to the last whole day within 30 days of the earliest start', () => {
    // 10:00 on Nov 7 + 30 days is 10:00 on Dec 7, so Dec 6 is the last day that ends in time.
    expect(latestEndDate(['2026-11-14T22:00:00Z', '2026-11-07T16:00:00Z'], ZONE)).toBe('2026-12-06');
    // From a midnight start the limit is midnight too, and the day before it ends exactly there.
    expect(latestEndDate(['2026-11-07T06:00:00Z'], ZONE)).toBe('2026-12-06');
    expect(latestEndDate([], ZONE)).toBeNull();
  });
});

describe('shouldPollLeases', () => {
  it('reads again while a notice is sending, for at most 2 minutes', () => {
    const sending = [{ notice: 'sending' as const }];
    expect(shouldPollLeases(sending, 0, 119_999)).toBe(true);
    expect(shouldPollLeases(sending, 0, 120_000)).toBe(false);
    expect(shouldPollLeases([{ notice: 'delivered' as const }], 0, 1)).toBe(false);
    expect(shouldPollLeases([], 0, 1)).toBe(false);
  });
});
