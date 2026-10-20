/** Test-only factories for the calendar module. Not imported by production code. */
import type { PlaySession } from '../pokemon/ports/play-tools-gateway';
import type { CalendarRead, CalendarTournament } from '../tournaments/service';

export const LEAGUE = 'default';
export const OAK = '0099999';
export const MISTY = '0011111';
export const BROCK = '0022222';

/** A created, sanctioned tournament of Oak's from a planned row, listed by Oak. */
export function calendarTournament(overrides: Partial<CalendarTournament> = {}): CalendarTournament {
  return {
    plannedId: 1,
    tournamentId: 'g1',
    state: 'created',
    organizerPlayerId: OAK,
    name: "Ettin's November TCG Challenge",
    startsAt: '2026-11-07T19:00:00.000Z',
    product: 'tcg',
    applicationState: 'sanctioned',
    venueLabel: 'Cerulean Gym',
    registration: null,
    eventWebsite: 'https://example.test/t1',
    listedBy: OAK,
    ...overrides,
  };
}

/** A play-tools tournament no planned row holds. */
export function upstreamOnly(id: string, organizer: string, overrides: Partial<CalendarTournament> = {}): CalendarTournament {
  return calendarTournament({
    plannedId: null,
    tournamentId: id,
    state: 'upstream',
    organizerPlayerId: organizer,
    name: `Cup ${id}`,
    venueLabel: null,
    eventWebsite: null,
    listedBy: organizer,
    ...overrides,
  });
}

/** A refresh that read every listed professor successfully. */
export function refreshRead(tournaments: CalendarTournament[], overrides: Partial<CalendarRead> = {}): CalendarRead {
  const read = [...new Set(tournaments.flatMap((t) => (t.listedBy ? [t.listedBy] : [])))];
  return { tournaments, upstream: 'read', read, failed: [], unmatched: false, ...overrides };
}

export function localRead(tournaments: CalendarTournament[]): CalendarRead {
  return {
    tournaments: tournaments.map((t) => ({ ...t, listedBy: null, applicationState: null })),
    upstream: 'local',
    read: [],
    failed: [],
    unmatched: false,
  };
}

export function playSession(id: string, startsAt: string, overrides: Partial<PlaySession> = {}): PlaySession {
  return {
    id,
    type: 'open_play',
    products: ['tcg', 'vg'],
    startsAt: new Date(startsAt),
    endsAt: null,
    editableUntil: null,
    status: 'pending',
    ...overrides,
  };
}
