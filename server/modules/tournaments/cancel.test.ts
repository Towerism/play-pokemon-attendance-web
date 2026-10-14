import { describe, expect, it } from 'vitest';
import type { TournamentDetails, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import { cancellability, confirmationFor, participantCounts } from './cancel';

const ZONE = 'America/Chicago';
const DAY = 86_400_000;
/** 2026-10-20 18:00 in Chicago (CDT). */
const START = new Date('2026-10-20T23:00:00Z');
const UNTIL = new Date(START.getTime() + 90 * DAY);

function read(overrides: Partial<TournamentDetails> = {}): TournamentDetails {
  return {
    id: 'guid-1',
    name: 'Friday Cup',
    displayId: '26-10-000001',
    groupId: 'group-1',
    products: ['tcg'],
    startsAt: START,
    status: 'sanctioned',
    editableUntil: UNTIL,
    organizerPlayerId: '9999991' as never,
    organizerName: 'Olive Organizer',
    applicationState: 'sanctioned',
    activityState: 'pending',
    category: 'tcg_std',
    series: null,
    venue: { id: 'venue-1', timeZone: ZONE },
    contact: { email: null, phone: null },
    registration: null,
    onSiteAdmission: null,
    thirdPartyRegistrationUrl: null,
    details: null,
    eventWebsite: null,
    ...overrides,
  };
}

const person = (playerId: string, role: string | null): TournamentParticipant => ({
  recordId: `rec-${playerId}`,
  playerId: playerId as never,
  role,
  isStaff: role !== null,
  name: `Player ${playerId}`,
});

describe('cancellability: what play-tools lets a professor cancel', () => {
  it.each([
    ['sanctioned', 'sanctioned', 'pending'],
    ['approval-pending', 'approval-pending', 'pending'],
    ['sanctioning-error', 'sanctioning-error', 'pending'],
  ])('allows %s', (applicationState, status, activityState) => {
    expect(cancellability(read({ applicationState, status, activityState }), START)).toEqual({ cancellable: true, reason: null });
  });

  it('says a cancelled tournament is already cancelled, by either field', () => {
    expect(cancellability(read({ applicationState: 'cancelled', status: 'cancelled' }), START)).toEqual({ cancellable: false, reason: 'already_cancelled' });
    expect(cancellability(read({ applicationState: null, status: 'cancelled' }), START)).toEqual({ cancellable: false, reason: 'already_cancelled' });
  });

  it.each([
    ['a complete status', { status: 'complete' }],
    ['a deleted status', { status: 'deleted' }],
    ['an invalidated status', { status: 'invalidated' }],
    ['completed results', { activityState: 'completed' }],
    ['a state play-tools does not let a professor cancel', { applicationState: 'draft', status: 'draft' }],
  ])('locks a tournament with %s', (_what, overrides) => {
    expect(cancellability(read(overrides), START)).toEqual({ cancellable: false, reason: 'tournament_locked' });
  });

  it('locks a tournament once 90 days have passed since its start, and not before', () => {
    expect(cancellability(read(), new Date(UNTIL.getTime() - 1))).toEqual({ cancellable: true, reason: null });
    expect(cancellability(read(), UNTIL)).toEqual({ cancellable: false, reason: 'tournament_locked' });
  });

  it('leaves a tournament with no start to play-tools', () => {
    expect(cancellability(read({ startsAt: null, editableUntil: null }), new Date('2030-01-01'))).toEqual({ cancellable: true, reason: null });
  });

  it('falls back to the status when play-tools gives no application state', () => {
    expect(cancellability(read({ applicationState: null, status: 'sanctioned' }), START).cancellable).toBe(true);
  });
});

describe('participantCounts', () => {
  it('counts players and staff, never the organizer, and staff in roles this app does not know', () => {
    const counts = participantCounts([
      person('1', 'organizer'),
      person('2', null),
      person('3', null),
      person('4', 'judge'),
      person('5', 'some_new_role'),
    ]);
    expect(counts).toEqual({ players: 2, staff: 2 });
  });

  it('is zero for a tournament listing only its organizer', () => {
    expect(participantCounts([person('1', 'organizer')])).toEqual({ players: 0, staff: 0 });
  });
});

describe('confirmationFor: what the organizer types when anyone is listed', () => {
  it('asks for nothing when nobody but the organizer is listed', () => {
    expect(confirmationFor(read(), { players: 0, staff: 0 }, ZONE)).toEqual({ required: false, with: null });
  });

  it('asks for the display id when anyone is listed, staff included', () => {
    expect(confirmationFor(read(), { players: 0, staff: 1 }, ZONE)).toEqual({ required: true, with: '26-10-000001' });
    expect(confirmationFor(read(), { players: 3, staff: 0 }, ZONE)).toEqual({ required: true, with: '26-10-000001' });
  });

  it("asks for the local date in the venue's zone when play-tools gives no display id", () => {
    // 2026-10-21 03:00Z is still the 20th in Chicago.
    const late = read({ displayId: null, startsAt: new Date('2026-10-21T03:00:00Z') });
    expect(confirmationFor(late, { players: 1, staff: 0 }, 'UTC')).toEqual({ required: true, with: '2026-10-20' });
  });

  it("uses the league's zone when the read names no venue zone", () => {
    const late = read({ displayId: null, venue: null, startsAt: new Date('2026-10-21T03:00:00Z') });
    expect(confirmationFor(late, { players: 1, staff: 0 }, 'UTC')).toEqual({ required: true, with: '2026-10-21' });
  });
});
