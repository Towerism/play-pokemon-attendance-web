import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { SightingsService } from '../metrics/sightings';
import type { SessionsService } from '../sessions/service';

export interface ForgetDeps {
  sessions: Pick<SessionsService, 'removePlayer'>;
  sightings: Pick<SightingsService, 'retract'>;
}

/**
 * A player's attendance on a date is gone from play-tools (undo, clear
 * session): take them off the date's session players and retract their
 * `tdf` and `manual` sightings, so the evidence matches upstream (ADR-0005).
 * Regulars stay regulars; `upstream_existing` sightings stay. Idempotent.
 * Call it inside the transaction that records why.
 */
export function forgetAttendance(deps: ForgetDeps, leagueId: string, date: SessionDate, playerId: PlayerId): void {
  deps.sessions.removePlayer(leagueId, date, playerId);
  deps.sightings.retract(leagueId, date, 'tdf', [playerId]);
  deps.sightings.retract(leagueId, date, 'manual', [playerId]);
}
