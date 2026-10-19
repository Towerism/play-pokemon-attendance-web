import { type MetricsService, createMetricsService } from '../modules/metrics/metrics';
import { type SightingsService, createSightingsService } from '../modules/metrics/sightings';
import { type RosterService, createRosterService } from '../modules/roster/service';
import { type SessionsService, createSessionsService } from '../modules/sessions/service';
import { type TdfImportService, createTdfImportService } from '../modules/sessions/tdf-import';

let roster: RosterService | undefined;
let sessions: SessionsService | undefined;
let sightings: SightingsService | undefined;
let tdfImports: TdfImportService | undefined;
let metrics: MetricsService | undefined;

export function useRoster(): RosterService {
  roster ??= createRosterService({ db: useDb() });
  return roster;
}

export function useSessions(): SessionsService {
  sessions ??= createSessionsService({ db: useDb(), roster: useRoster(), sightings: useSightings() });
  return sessions;
}

export function useTdfImports(): TdfImportService {
  tdfImports ??= createTdfImportService({ db: useDb(), roster: useRoster(), sightings: useSightings(), archive: useTdfArchive() });
  return tdfImports;
}

export function useSightings(): SightingsService {
  sightings ??= createSightingsService({ db: useDb() });
  return sightings;
}

export function useMetrics(): MetricsService {
  metrics ??= createMetricsService({ db: useDb(), roster: useRoster(), submissions: useSubmissions() });
  return metrics;
}
