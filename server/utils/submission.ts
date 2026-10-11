import { createPlayToolsHttpAdapter } from '../modules/pokemon/adapters/play-tools/gateway';
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

function gateway(leagueId: string) {
  return createPlayToolsHttpAdapter({
    tokens: usePokemon(),
    leagueId,
    baseUrl: useRuntimeConfig().pokemon.apiUrl,
    log: useLogger('pokemon'),
  });
}

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
      resolver: usePlaySessionResolver(),
      batchSize: Math.min(50, Number(config.batchSize)),
      batchDelayMs: Number(config.batchDelayMs),
      settleMs: Number(config.settleMs),
      settlePollMs: Number(config.settlePollMs),
      undoDelayMs: Math.max(500, Number(useRuntimeConfig().undo.delayMs) || 0),
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
};

/** Maps submission and Pokémon errors to HTTP; `data.code` tells the UI what to show. */
export function submissionHttpError(err: unknown): never {
  if (err instanceof SubmissionError) {
    throw createError({ statusCode: STATUS[err.code], message: err.message, data: { code: err.code } });
  }
  return pokemonHttpError(err);
}
