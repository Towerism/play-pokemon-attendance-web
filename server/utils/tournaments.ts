import { TdfError } from '../../shared/tdf/parse';
import { TournamentsError, type TournamentsErrorCode } from '../modules/tournaments/errors';
import { type TournamentResults, createTournamentResults } from '../modules/tournaments/results';
import { type TournamentsService, createTournamentsService } from '../modules/tournaments/service';

let tournaments: TournamentsService | undefined;
let results: TournamentResults | undefined;

/**
 * TDF results uploads (ADR-0011, #96): reads only; the `tdf_upload` job sends. The organizer's full name lives on
 * their Pokémon connection (ADR-0011 decision 8).
 */
export function useTournamentResults(): TournamentResults {
  results ??= createTournamentResults({
    db: useDb(),
    connections: usePokemon(),
    gateway: connectionGateway,
    names: {
      fullNameOf: (leagueId, playerId) => usePokemon().listConnections(leagueId).find((c) => c.professorPlayerId === playerId)?.professorFullName ?? null,
      saveFullName: (leagueId, playerId, fullName) => void usePokemon().renameProfessor(leagueId, playerId, { fullName }),
    },
    archive: useTdfArchive(),
    attendance: useTdfImports(),
    roster: useRoster(),
    timeZone: leagueTimeZone(),
  });
  return results;
}

/**
 * Maps a results route's errors: the parser's refusals (422 with their code), the archive's, then submission,
 * tournaments and Pokémon errors.
 */
export function resultsHttpError(err: unknown): never {
  if (err instanceof TdfError) throw createError({ statusCode: 422, message: err.message, data: { code: err.code } });
  const archived = tdfArchiveHttpError(err);
  if (archived !== err) throw archived;
  return submissionHttpError(err);
}

/** Templates, scaffolds, schedules and planned tournaments (ADR-0010). */
export function useTournaments(): TournamentsService {
  tournaments ??= createTournamentsService({
    db: useDb(),
    connections: usePokemon(),
    gateway: connectionGateway,
    staffing: useStaffing(),
    timeZone: leagueTimeZone(),
  });
  return tournaments;
}

const STATUS: Record<TournamentsErrorCode, number> = {
  not_found: 404,
  connection_not_found: 404,
  contact_required: 400,
  invalid_range: 400,
  template_in_use: 409,
  scaffold_in_use: 409,
  already_planned: 409,
  not_editable: 409,
  league_not_selected: 409,
  needs_reconnect: 409,
  organizer_not_connected: 422,
  unknown_template: 422,
  template_archived: 422,
  unknown_scaffold: 422,
  scaffold_archived: 422,
  date_too_far_past: 422,
  date_too_far_ahead: 422,
  not_creatable: 409,
  schedule_inactive: 409,
  retry_not_confirmed: 422,
  short_notice_not_acknowledged: 422,
  too_many_tournaments: 422,
  nothing_to_create: 422,
  tournament_locked: 422,
  reschedule_window_not_open: 422,
  reschedule_window_closed: 422,
  outside_series_window: 422,
  format_not_in_series: 422,
  venue_not_found: 422,
  start_time_invalid: 422,
  nothing_to_change: 422,
  not_in_schedule: 422,
  no_template: 422,
  nothing_to_edit: 422,
  not_in_play_tools: 409,
  confirmation_mismatch: 422,
  nothing_to_cancel: 422,
  requirement_exists: 409,
  requirement_has_covers: 409,
  invalid_period: 400,
  too_many_requirements: 422,
  results_not_accepted: 422,
  results_already_uploaded: 422,
  organizer_full_name_required: 422,
  organizer_name_not_needed: 409,
  tdf_file_deleted: 409,
  not_removable: 422,
  warnings_not_acknowledged: 422,
  upload_not_open: 409,
  use_upload_again: 422,
  nothing_to_retry: 422,
};

/**
 * Maps tournaments and Pokémon errors to HTTP; `data.code` tells the UI what to show, with the error's details
 * (`scaffoldIds`, `scheduleIds`, `plannedTournamentId`, `state`, `professorPlayerId`).
 */
export function tournamentsHttpError(err: unknown): never {
  if (err instanceof TournamentsError) {
    throw createError({ statusCode: STATUS[err.code], message: err.message, data: { code: err.code, ...err.details } });
  }
  return pokemonHttpError(err);
}

/** Runs a synchronous service call, mapping its errors. */
export function tournamentsCall<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    return tournamentsHttpError(err);
  }
}
