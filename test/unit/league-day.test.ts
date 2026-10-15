import { describe, expect, it } from 'vitest';
import { leagueDay } from '../server/league-day';

const TZ = 'America/Chicago';
const at = (iso: string) => new Date(iso);

/** The server tests' expected dates count calendar days in the league's zone, so a DST change between today and the target can't shift them. */
describe('leagueDay', () => {
  it('counts calendar days past fall-back when run in the hour after league midnight', () => {
    // 00:35 CDT; 24 × 24 h later is 23:35 CST the day before.
    expect(leagueDay(24, TZ, at('2026-10-15T05:35:00Z'))).toBe('2026-11-08');
  });

  it('reads today in the league zone, not UTC, at the last second of a league day', () => {
    const now = at('2026-10-15T04:59:59Z'); // 23:59:59 CDT on 10-14
    expect(leagueDay(0, TZ, now)).toBe('2026-10-14');
    expect(leagueDay(1, TZ, now)).toBe('2026-10-15');
  });

  it('goes back across fall-back and forward past spring-forward from just before midnight', () => {
    const now = at('2026-11-02T05:30:00Z'); // 23:30 CST on 11-01
    expect(leagueDay(-1, TZ, now)).toBe('2026-10-31');
    expect(leagueDay(140, TZ, now)).toBe('2027-03-21');
  });

  it('goes back across spring-forward when run in the hour after league midnight', () => {
    expect(leagueDay(-1, TZ, at('2027-03-15T05:30:00Z'))).toBe('2027-03-14'); // 00:30 CDT on 03-15
  });

  it('rolls over months and years', () => {
    expect(leagueDay(1, TZ, at('2027-01-01T05:30:00Z'))).toBe('2027-01-01'); // 23:30 CST on 12-31
    expect(leagueDay(-1, TZ, at('2027-03-01T18:00:00Z'))).toBe('2027-02-28');
  });
});
