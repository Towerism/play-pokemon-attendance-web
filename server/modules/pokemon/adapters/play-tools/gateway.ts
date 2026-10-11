import type { z } from 'zod';
import { PokemonUpstreamError } from '../../ports/errors';
import type { League, PlayToolsGateway } from '../../ports/play-tools-gateway';
import type { TokenProvider } from '../../ports/token-provider';
import { fetchUpstream, jsonOrUndefined, throttleOrServerError } from '../http';
import { OP_API_BASE, OP_API_HEADERS, opPaths } from './constants';
import { ActivityGroupsPage } from './wire';

export interface PlayToolsHttpAdapterOptions {
  tokens: TokenProvider;
  leagueId: string;
  /** Replaces `https://api.play.pokemon.com/services/` (test doubles only; `NUXT_POKEMON_API_URL`). */
  baseUrl?: string;
  log?: { warn(message: string, data: { body: unknown }): void };
}

/** The gateway as built so far: league discovery (M4). Sessions and attendance arrive with M5. */
export type PlayToolsHttpAdapter = Pick<PlayToolsGateway, 'listLeagues'>;

/**
 * PlayToolsHttpAdapter (architecture §4.3). The only code that knows the OP
 * API's paths, headers and JSON; responses are checked against the frozen
 * wire schemas, and an unexpected shape fails loudly with the body logged.
 */
export function createPlayToolsHttpAdapter(opts: PlayToolsHttpAdapterOptions): PlayToolsHttpAdapter {
  const base = new URL(opts.baseUrl || OP_API_BASE);
  const log = opts.log ?? { warn: (message, data) => console.warn(message, data) };

  async function get(url: URL, what: string): Promise<unknown> {
    const token = await opts.tokens.getAccessToken(opts.leagueId);
    const res = await fetchUpstream(url.toString(), { headers: { ...OP_API_HEADERS, authorization: `Bearer ${token.value}` } }, what);
    if (res.ok) return jsonOrUndefined(res);
    throw throttleOrServerError(res, what) ?? clientError(res.status, what);
  }

  /** Every page of a DRF list, following `next` only within the OP API's own origin. */
  async function getAll<T>(path: string, schema: z.ZodType<{ items: T[]; next: string | null }>, what: string): Promise<T[]> {
    const items: T[] = [];
    let url: URL | undefined = new URL(path, base);
    while (url) {
      const body = await get(url, what);
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        log.warn(`[pokemon] ${what}: response did not match the wire contract (${url.pathname})`, { body });
        throw new PokemonUpstreamError('unexpected_shape', `${what}: Pokémon sent a response this version does not understand.`);
      }
      items.push(...parsed.data.items);
      url = parsed.data.next ? sameOrigin(parsed.data.next, what) : undefined;
    }
    return items;
  }

  function sameOrigin(next: string, what: string): URL {
    const url = new URL(next, base);
    if (url.origin !== base.origin) {
      throw new PokemonUpstreamError('unexpected_shape', `${what}: Pokémon linked the next page to another host (${url.origin}).`);
    }
    return url;
  }

  return {
    async listLeagues(): Promise<League[]> {
      const { subject } = await opts.tokens.getAccessToken(opts.leagueId);
      const groups = await getAll(opPaths.userActivityGroups(subject), ActivityGroupsPage, 'League discovery');
      return groups
        .filter((g) => g.group_type === 'league')
        .map((g) => ({
          id: g.guid,
          name: g.display_name || g.name || g.display_id || g.guid,
          displayId: g.display_id,
          canSubmit: g.criteria?.play_sessions?.create_attendance === true,
        }));
    },
  };
}

function clientError(status: number, what: string): PokemonUpstreamError {
  if (status === 401 || status === 403) {
    return new PokemonUpstreamError('forbidden', `${what}: play-tools refused the request (${status}).`, { status });
  }
  if (status === 404) return new PokemonUpstreamError('not_found', `${what}: not found in play-tools.`, { status });
  return new PokemonUpstreamError('unexpected_shape', `${what}: play-tools answered ${status}.`, { status });
}
