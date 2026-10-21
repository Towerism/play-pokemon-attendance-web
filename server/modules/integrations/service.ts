import type { AttendanceDayV1 } from '../../../shared/schemas/integrations';
import type { SessionDate } from '../../../shared/types/ids';
import type { Logger } from '@towerism/selfhost-kit';
import type { PokemonConnectionService } from '../pokemon/connection';
import type { StaffingService } from '../staffing/service';
import type { TournamentsService } from '../tournaments/service';
import { toAttendanceDay } from './day';

export interface IntegrationDayService {
  /**
   * The v1 day (#115): every connected professor's (not outside the league) tournaments in the league that start on the date, read live,
   * with their live staff assignments and each professor's read outcome. With no professor connected, an empty
   * day and no upstream call.
   * @throws StaffingError `league_not_selected`, IntegrationError `professor_unidentified`
   */
  day(leagueId: string, date: SessionDate): Promise<AttendanceDayV1>;
}

export interface IntegrationDayDeps {
  staffing: Pick<StaffingService, 'daySnapshot'>;
  connections: Pick<PokemonConnectionService, 'listReadableConnections'>;
  /** Each tournament's admission from the app's planned rows (#194). */
  tournaments: Pick<TournamentsService, 'admissionsFor'>;
  timeZone: string;
  log: Logger;
}

export function createIntegrationDayService(deps: IntegrationDayDeps): IntegrationDayService {
  return {
    async day(leagueId, date) {
      // A connection outside the league is never read for it (ADR-0015 §3).
      if (deps.connections.listReadableConnections().length === 0) {
        return { date, timezone: deps.timeZone, tournaments: [], professors: [] };
      }
      const snapshot = await deps.staffing.daySnapshot(leagueId, date);
      // Read again: a professor's first successful token use fills in their player id.
      const admissions = deps.tournaments.admissionsFor(
        leagueId,
        snapshot.tournaments.map((t) => t.tournament.id),
      );
      const { day, skipped } = toAttendanceDay({ date, snapshot, connections: deps.connections.listReadableConnections(), admissions });
      for (const s of skipped) {
        deps.log.warn('staff assignment left out of the integrations day: its role is not a contract role', { ...s });
      }
      return day;
    },
  };
}
