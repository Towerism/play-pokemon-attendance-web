import { createPlayToolsHttpAdapter } from '../modules/pokemon/adapters/play-tools/gateway';
import { StaffingError, type StaffingErrorCode } from '../modules/staffing/errors';
import { type StaffingService, createStaffingService } from '../modules/staffing/service';

let staffing: StaffingService | undefined;

/** Staff assignments and the staff list (ADR-0007). */
export function useStaffing(): StaffingService {
  staffing ??= createStaffingService({
    db: useDb(),
    roster: useRoster(),
    connections: usePokemon(),
    gateway: (leagueId) =>
      createPlayToolsHttpAdapter({
        tokens: usePokemon(),
        leagueId,
        baseUrl: useRuntimeConfig().pokemon.apiUrl,
        log: useLogger('pokemon'),
      }),
    timeZone: leagueTimeZone(),
  });
  return staffing;
}

const STATUS: Record<StaffingErrorCode, number> = {
  unknown_role: 422,
  unknown_tournament: 422,
  tournament_locked: 422,
  organizer_cannot_staff: 422,
  player_already_staffed: 409,
  already_listed: 409,
  league_not_selected: 409,
  not_found: 404,
  nothing_to_apply: 422,
};

/** Maps staffing and Pokémon errors to HTTP; `data.code` (and `data.how` for `already_listed`) tells the UI what to show. */
export function staffingHttpError(err: unknown): never {
  if (err instanceof StaffingError) {
    throw createError({ statusCode: STATUS[err.code], message: err.message, data: { code: err.code, ...err.details } });
  }
  return pokemonHttpError(err);
}
