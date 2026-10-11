import { createPlayToolsHttpAdapter } from '../modules/pokemon/adapters/play-tools/gateway';
import { SubmissionError, type SubmissionErrorCode } from '../modules/submission/errors';
import { type PlaySessionResolver, createPlaySessionResolver } from '../modules/submission/resolve';
import { type SubmissionService, createSubmissionService } from '../modules/submission/service';

let resolver: PlaySessionResolver | undefined;
let submissions: SubmissionService | undefined;

/** The league timezone: the container's `TZ` (ADR-0006). */
export const leagueTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function gateway(leagueId: string) {
  return createPlayToolsHttpAdapter({ tokens: usePokemon(), leagueId, baseUrl: useRuntimeConfig().pokemon.apiUrl });
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
};

/** Maps submission and Pokémon errors to HTTP; `data.code` tells the UI what to show. */
export function submissionHttpError(err: unknown): never {
  if (err instanceof SubmissionError) {
    throw createError({ statusCode: STATUS[err.code], message: err.message, data: { code: err.code } });
  }
  return pokemonHttpError(err);
}
