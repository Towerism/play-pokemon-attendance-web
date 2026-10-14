import { TournamentsError, type TournamentsErrorCode } from '../modules/tournaments/errors';
import { type TournamentsService, createTournamentsService } from '../modules/tournaments/service';

let tournaments: TournamentsService | undefined;

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
