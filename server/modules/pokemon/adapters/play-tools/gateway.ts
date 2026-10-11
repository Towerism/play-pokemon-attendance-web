import type { z } from 'zod';
import { type Logger, silentLogger } from '../../../../logging/types';
import { PokemonUpstreamError } from '../../ports/errors';
import { type PlayerId, toPlayerId } from '../../../../../shared/types/ids';
import type { AttendanceRecord, BulkResult, League, PlaySession, PlaySessionStatus, PlayToolsGateway } from '../../ports/play-tools-gateway';
import type { TokenProvider } from '../../ports/token-provider';
import { fetchUpstream, jsonOrUndefined, throttleOrServerError } from '../http';
import { OP_API_BASE, OP_API_HEADERS, opPaths } from './constants';
import {
  ActivityGroupsPage,
  AttendancePage,
  BulkResponse,
  DUPLICATE_PARTICIPANT,
  OpErrorResponse,
  PLAY_SESSION_START_GTE,
  PLAY_SESSION_START_LTE,
  PlaySessionsPage,
  bulkRequestBody,
} from './wire';

/** §4.4: the order statuses are tried in when resolving a date. */
const RESOLVE_ORDER: readonly PlaySessionStatus[] = ['active', 'complete', 'pending'];
const PAGE_SIZE = '100';

export interface PlayToolsHttpAdapterOptions {
  tokens: TokenProvider;
  leagueId: string;
  /** Replaces `https://api.play.pokemon.com/services/` (test doubles only; `NUXT_POKEMON_API_URL`). */
  baseUrl?: string;
  log?: Pick<Logger, 'warn'>;
}

/** The gateway as built so far. `removeAttendance` (undo) arrives with M7. */
export type PlayToolsHttpAdapter = Omit<PlayToolsGateway, 'removeAttendance'>;

/**
 * PlayToolsHttpAdapter (architecture §4.3). The only code that knows the OP
 * API's paths, headers and JSON; responses are checked against the frozen
 * wire schemas, and an unexpected shape fails loudly with its outline logged
 * (keys and schema issues, never values: bodies carry minors' names).
 */
export function createPlayToolsHttpAdapter(opts: PlayToolsHttpAdapterOptions): PlayToolsHttpAdapter {
  const base = new URL(opts.baseUrl || OP_API_BASE);
  const log = opts.log ?? silentLogger;

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
      if (!parsed.success) throw unexpected(what, url, body, parsed.error);
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

    async listPlaySessions(groupId, range, statuses = RESOLVE_ORDER): Promise<PlaySession[]> {
      for (const status of statuses) {
        const query = new URLSearchParams({
          status,
          [PLAY_SESSION_START_GTE]: range.from.toISOString(),
          [PLAY_SESSION_START_LTE]: range.to.toISOString(),
          page_size: PAGE_SIZE,
        });
        const found = (await getAll(`${opPaths.playSessions(groupId)}?${query}`, PlaySessionsPage, 'Play sessions'))
          .map((s) => ({
            id: s.guid,
            type: s.type,
            products: s.products,
            status: s.status,
            startsAt: new Date(s.start_date),
            endsAt: s.end_date ? new Date(s.end_date) : null,
            editableUntil: s.final_modifiable_datetime ? new Date(s.final_modifiable_datetime) : null,
          }))
          // The upstream filter is inclusive; the range's end is not.
          .filter((s) => s.startsAt >= range.from && s.startsAt < range.to);
        if (found.length > 0) return found;
      }
      return [];
    },

    async listAttendance(groupId, sessionId): Promise<AttendanceRecord[]> {
      // Unfiltered on purpose: `?player=true` hides staff records, and upstream refuses to add them again (S4).
      const query = new URLSearchParams({ page_size: PAGE_SIZE });
      const records = await getAll(`${opPaths.records(groupId, sessionId)}?${query}`, AttendancePage, 'Attendance');
      return records.map((r) => ({
        recordId: r.recordId,
        playerId: r.participant.player_id as PlayerId,
        isPlayer: r.player,
        name: [r.participant.display_first_name, r.participant.display_last_name].filter(Boolean).join(' '),
      }));
    },

    async addAttendanceBulk(groupId, sessionId, playerIds): Promise<BulkResult> {
      // One malformed id makes upstream fail the whole call with an HTML 500 (S4).
      const ids = playerIds.map((id) => toPlayerId(id));
      if (ids.length === 0) return { status: 'added', records: [] };

      const what = 'Adding attendance';
      const token = await opts.tokens.getAccessToken(opts.leagueId);
      const url = new URL(opPaths.recordsBulk(groupId, sessionId), base);
      const res = await fetchUpstream(
        url.toString(),
        {
          method: 'POST',
          headers: { ...OP_API_HEADERS, authorization: `Bearer ${token.value}`, 'content-type': 'application/json' },
          body: JSON.stringify(bulkRequestBody(ids)),
        },
        what,
      );
      const body = await jsonOrUndefined(res);

      if (res.ok) {
        const parsed = BulkResponse.safeParse(body);
        if (!parsed.success || parsed.data.length !== ids.length) throw unexpected(what, url, body, parsed.error);
        return { status: 'added', records: ids.map((playerId, i) => ({ playerId, recordId: parsed.data[i]!.guid })) };
      }
      if (res.status === 400) {
        const parsed = OpErrorResponse.safeParse(body);
        if (!parsed.success) throw unexpected(what, url, body, parsed.error);
        return rejection(ids, parsed.data);
      }
      throw throttleOrServerError(res, what) ?? clientError(res.status, what);
    },
  };

  function unexpected(what: string, url: URL, body: unknown, error: z.ZodError | undefined): PokemonUpstreamError {
    log.warn(`${what}: response did not match the wire contract`, {
      what,
      path: url.pathname,
      ...outline(body),
      issues: (error?.issues ?? []).map((issue) => ({ path: issue.path, code: issue.code })),
    });
    return new PokemonUpstreamError('unexpected_shape', `${what}: Pokémon sent a response this version does not understand.`);
  }
}

const BULK_ITEM_FIELD = /^(\d+)\.participant\.player_id$/;

/** A 400 from `_bulk` (S4): errors keyed `<index>.participant.player_id`; the batch added nobody. */
function rejection(ids: readonly PlayerId[], error: OpErrorResponse): BulkResult {
  const alreadyPresent: PlayerId[] = [];
  const failed: { playerId: PlayerId; error: string }[] = [];
  for (const [field, problems] of Object.entries(error.errors?.body ?? {})) {
    const playerId = ids[Number(BULK_ITEM_FIELD.exec(field)?.[1])];
    if (!playerId) continue;
    if (problems.some((p) => p.code === DUPLICATE_PARTICIPANT)) alreadyPresent.push(playerId);
    else failed.push({ playerId, error: problems[0]?.code ?? error.code });
  }
  if (alreadyPresent.length === 0 && failed.length === 0) {
    return { status: 'rejected', alreadyPresent, failed: ids.map((playerId) => ({ playerId, error: error.code })) };
  }
  const order = (a: PlayerId, b: PlayerId) => ids.indexOf(a) - ids.indexOf(b);
  return { status: 'rejected', alreadyPresent: alreadyPresent.sort(order), failed: failed.sort((a, b) => order(a.playerId, b.playerId)) };
}

function clientError(status: number, what: string): PokemonUpstreamError {
  if (status === 401 || status === 403) {
    return new PokemonUpstreamError('forbidden', `${what}: play-tools refused the request (${status}).`, { status });
  }
  if (status === 404) return new PokemonUpstreamError('not_found', `${what}: not found in play-tools.`, { status });
  return new PokemonUpstreamError('unexpected_shape', `${what}: play-tools answered ${status}.`, { status });
}

/** A body's shape without its values: top-level keys, or its JSON type ("string" when it was not JSON). */
function outline(body: unknown): { keys: string[] | string } {
  if (body === undefined) return { keys: 'string' };
  if (body === null) return { keys: 'null' };
  if (Array.isArray(body)) return { keys: 'array' };
  if (typeof body === 'object') return { keys: Object.keys(body) };
  return { keys: typeof body };
}
