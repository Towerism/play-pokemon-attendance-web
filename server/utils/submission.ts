import { StaffingError } from '../modules/staffing/errors';
import { SubmissionError, type SubmissionErrorCode } from '../modules/submission/errors';
import { dateIn } from '../modules/submission/local-time';
import { type PlaySessionResolver, createPlaySessionResolver } from '../modules/submission/resolve';
import { type SubmissionService, createSubmissionService } from '../modules/submission/service';

let resolver: PlaySessionResolver | undefined;
let submissions: SubmissionService | undefined;

/** The league timezone: the container's `TZ` (ADR-0006). */
export const leagueTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Today's session date in the league timezone; curation metrics are as of this date. */
export const leagueToday = () => dateIn(new Date(), leagueTimeZone());

/** Attendance calls are made as the league's submitting professor (ADR-0008); tournament calls as each tournament's organizer (#75). */
const gateway = (leagueId: string) => leagueGateway(leagueId);

export function usePlaySessionResolver(): PlaySessionResolver {
  resolver ??= createPlaySessionResolver({ connections: usePokemon(), gateway, timeZone: leagueTimeZone() });
  return resolver;
}

export function useSubmissions(): SubmissionService {
  if (!submissions) {
    const config = useRuntimeConfig().submission;
    submissions = createSubmissionService({
      db: useDb(),
      sessions: useSessions(),
      roster: useRoster(),
      sightings: useSightings(),
      connections: usePokemon(),
      gateway,
      staffGateway: connectionGateway,
      staffing: useStaffing(),
      resolver: usePlaySessionResolver(),
      timeZone: leagueTimeZone(),
      batchSize: Math.min(50, Number(config.batchSize)),
      batchDelayMs: Number(config.batchDelayMs),
      settleMs: Number(config.settleMs),
      settlePollMs: Number(config.settlePollMs),
      undoDelayMs: Math.max(500, Number(useRuntimeConfig().undo.delayMs) || 0),
      staffDelayMs: Number(useRuntimeConfig().staff.delayMs) || 0,
      log: useLogger('submission'),
    });
  }
  return submissions;
}

/** Stops running jobs before the database closes; a no-op when no submission ran. */
export async function stopSubmissions(): Promise<void> {
  await submissions?.shutdown();
}

const STATUS: Record<SubmissionErrorCode, number> = {
  league_not_selected: 409,
  cannot_submit: 403,
  unknown_play_session: 422,
  edit_window_closed: 422,
  nothing_to_submit: 422,
  submission_running: 409,
  shutting_down: 503,
  not_found: 404,
  not_undoable: 422,
  nothing_to_undo: 422,
  confirmation_mismatch: 422,
  nothing_to_clear: 422,
};

/** Maps submission, staffing (a staff job's checks) and Pokémon errors to HTTP; `data.code` tells the UI what to show. */
export function submissionHttpError(err: unknown): never {
  if (err instanceof SubmissionError) {
    throw createError({ statusCode: STATUS[err.code], message: err.message, data: { code: err.code } });
  }
  if (err instanceof StaffingError) return staffingHttpError(err);
  return pokemonHttpError(err);
}

/** Clear session runs only when the organizer typed the session's date exactly; 422 `confirmation_mismatch` otherwise. */
export function assertClearConfirmed(date: string, confirmDate: string): void {
  if (confirmDate !== date) {
    submissionHttpError(new SubmissionError('confirmation_mismatch', `Type ${date} exactly to confirm clearing the session.`));
  }
}
