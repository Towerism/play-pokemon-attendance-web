import type { H3Event } from 'h3';
import { DEFAULT_LEAGUE_ID } from '../modules/leagues';
import { createSightingsService } from '../modules/metrics/sightings';
import { type RosterService, createRosterService } from '../modules/roster/service';
import { type SessionsService, createSessionsService } from '../modules/sessions/service';

let roster: RosterService | undefined;
let sessions: SessionsService | undefined;

export function useRoster(): RosterService {
  roster ??= createRosterService({ db: useDb() });
  return roster;
}

export function useSessions(): SessionsService {
  sessions ??= createSessionsService({ db: useDb(), roster: useRoster(), sightings: createSightingsService({ db: useDb() }) });
  return sessions;
}

/** Requires a logged-in organizer and returns their league (v1: the single seeded league). */
export async function requireLeague(event: H3Event): Promise<string> {
  await requireUserSession(event);
  return DEFAULT_LEAGUE_ID;
}
