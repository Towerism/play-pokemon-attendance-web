import { TournamentsError, type TournamentsErrorCode } from '../modules/tournaments/errors';
import { type TournamentsService, createTournamentsService } from '../modules/tournaments/service';

let tournaments: TournamentsService | undefined;

/** Templates, scaffolds, schedules and planned tournaments (ADR-0010). */
export function useTournaments(): TournamentsService {
  tournaments ??= createTournamentsService({
    db: useDb(),
    connections: usePokemon(),
    gateway: connectionGateway,
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
