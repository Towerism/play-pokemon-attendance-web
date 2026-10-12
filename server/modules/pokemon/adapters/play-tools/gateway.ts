import type { z } from 'zod';
import { type Logger, silentLogger } from '../../../../logging/types';
import { PokemonUpstreamError } from '../../ports/errors';
import { type PlayerId, toPlayerId } from '../../../../../shared/types/ids';
import type {
  AttendanceRecord,
  BulkResult,
  DateRange,
  League,
  PlaySession,
  PlaySessionStatus,
  PlayToolsGateway,
  Tournament,
  TournamentDetails as TournamentDetailsPort,
  StaffAssignResult,
  StaffRoleCode,
  TournamentParticipant,
} from '../../ports/play-tools-gateway';
import type { TokenProvider } from '../../ports/token-provider';
import { fetchUpstream, jsonOrUndefined, throttleOrServerError } from '../http';
import { OP_API_BASE, OP_API_HEADERS, STAFF_ROLES, opPaths, tournamentPaths } from './constants';
import {
  ActivitiesPage,
  type ActivityTournament,
  ActivityGroupsPage,
  DEAD_TOURNAMENT_STATUSES,
  AttendancePage,
  BulkResponse,
  DUPLICATE_PARTICIPANT,
  OpErrorResponse,
  PLAY_SESSION_START_GTE,
  PLAY_SESSION_START_LTE,
  PlaySessionsPage,
  STAFF_ERROR_FIELD,
  StaffAssignResponse,
  TournamentDetails,
  TournamentRecordsPage,
  bulkRequestBody,
  staffAssignBody,
} from './wire';

/** §4.4: the order statuses are tried in when resolving a date. */
const RESOLVE_ORDER: readonly PlaySessionStatus[] = ['active', 'complete', 'pending'];
const PAGE_SIZE = '100';
/** The page size play-tools' own tournament list uses (S6). */
const TOURNAMENT_PAGE_SIZE = '40';
const DAY_MS = 86_400_000;
/** Staff edits close 90 days after a tournament starts (S6: the UI's rule, enforced upstream with 423). */
const STAFF_EDIT_WINDOW_MS = 90 * DAY_MS;

export interface PlayToolsHttpAdapterOptions {
  tokens: TokenProvider;
  leagueId: string;
  /** Replaces `https://api.play.pokemon.com/services/` (test doubles only; `NUXT_POKEMON_API_URL`). */
  baseUrl?: string;
  log?: Pick<Logger, 'warn'>;
}

export type PlayToolsHttpAdapter = PlayToolsGateway;

/** Record ids are GUIDs; anything else could change the request path. */
const RECORD_ID = /^[A-Za-z0-9-]{1,64}$/;

/** A tournament GUID, refused before any call if it could change the request path. */
function tournamentGuid(id: string): string {
  if (!RECORD_ID.test(id)) throw new TypeError(`Not a tournament id: ${JSON.stringify(id)}`);
  return id;
}

function recordGuid(id: string): string {
  if (!RECORD_ID.test(id)) throw new TypeError(`Not a staff record id: ${JSON.stringify(id)}`);
  return id;
}

/** Only the roles play-tools offers; `organizer` is fixed upstream and never sent. */
function staffRole(role: string): StaffRoleCode {
  const known = STAFF_ROLES.find((r) => r.code === role);
  if (!known) throw new TypeError(`Not a staff role: ${JSON.stringify(role)}`);
  return known.code;
}

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

  /** A JSON write with a fresh token; the caller reads the status. */
  async function writeJson(method: 'POST' | 'PATCH' | 'DELETE', path: string, payload: unknown, what: string): Promise<{ res: Response; url: URL }> {
    const token = await opts.tokens.getAccessToken(opts.leagueId);
    const url = new URL(path, base);
    const res = await fetchUpstream(
      url.toString(),
      {
        method,
        headers: { ...OP_API_HEADERS, authorization: `Bearer ${token.value}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      what,
    );
    return { res, url };
  }

  /** Every page of a DRF list, following `next` only within the OP API's own origin. */
  async function getAll<T>(
    path: string,
    schema: z.ZodType<{ items: T[]; next: string | null }>,
    what: string,
    /** Stop after a page for which this holds, even if there is a next one. */
    done: (page: T[]) => boolean = () => false,
  ): Promise<T[]> {
    const items: T[] = [];
    let url: URL | undefined = new URL(path, base);
    while (url) {
      const body = await get(url, what);
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw unexpected(what, url, body, parsed.error);
      items.push(...parsed.data.items);
      url = parsed.data.next && !done(parsed.data.items) ? sameOrigin(parsed.data.next, what) : undefined;
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
    listStaffRoles: () => STAFF_ROLES,

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

    async listTournaments(range?: DateRange): Promise<Tournament[]> {
      // Upstream ignores date filters (S6), so page newest first and stop once a page reaches
      // back past the range. Pages are ordered by the wall-clock start, hence a day's margin.
      const query = new URLSearchParams({ type: 'tournament', role: 'organizer', sort_by: '-start_date', page_size: TOURNAMENT_PAGE_SIZE });
      const stopBefore = range && range.from.getTime() - DAY_MS;
      const rows = await getAll(`${tournamentPaths.activities()}?${query}`, ActivitiesPage, 'Tournaments', (page) =>
        stopBefore === undefined ? false : page.some((t) => t.start_date_v2 !== null && Date.parse(t.start_date_v2) < stopBefore),
      );
      return rows
        .filter((t) => t.activity_type === 'tournament' && !DEAD_TOURNAMENT_STATUSES.includes(t.status))
        .map(toTournament)
        .filter((t) => !range || (t.startsAt !== null && t.startsAt >= range.from && t.startsAt < range.to))
        .sort(byStart);
    },

    async getTournament(tournamentId): Promise<TournamentDetailsPort> {
      const what = 'Tournament';
      const url = new URL(tournamentPaths.details(tournamentGuid(tournamentId)), base);
      const body = await get(url, what);
      const parsed = TournamentDetails.safeParse(body);
      if (!parsed.success) throw unexpected(what, url, body, parsed.error);
      const t = parsed.data;
      return {
        ...toTournament({ ...t, activity_type: 'tournament', start_date_v2: t.start_date_v2 ?? t.start_date_actual ?? null }),
        organizerPlayerId: t.organizer.player_id as PlayerId,
      };
    },

    async listTournamentParticipants(tournamentId): Promise<TournamentParticipant[]> {
      // Unfiltered on purpose: players and staff together are "everyone the tournament lists" (ADR-0007 decision 8).
      const query = new URLSearchParams({ page_size: PAGE_SIZE });
      const records = await getAll(`${tournamentPaths.records(tournamentGuid(tournamentId))}?${query}`, TournamentRecordsPage, 'Tournament participants');
      return records.map((r) => ({
        recordId: r.guid,
        playerId: r.participant.player_id as PlayerId,
        role: r.role,
        isStaff: !r.player,
        name: [r.participant.display_first_name, r.participant.display_last_name].filter(Boolean).join(' '),
      }));
    },

    async assignStaff(tournamentId, { playerId, role }): Promise<StaffAssignResult> {
      const path = tournamentPaths.records(tournamentGuid(tournamentId));
      const body = staffAssignBody(toPlayerId(playerId), staffRole(role));
      const what = 'Assigning staff';
      const { res, url } = await writeJson('POST', path, body, what);
      const json = await jsonOrUndefined(res);

      if (res.ok) {
        const parsed = StaffAssignResponse.safeParse(json);
        if (!parsed.success) throw unexpected(what, url, json, parsed.error);
        return { status: 'assigned', recordId: parsed.data.guid };
      }
      if (res.status === 400) {
        const parsed = OpErrorResponse.safeParse(json);
        if (!parsed.success) throw unexpected(what, url, json, parsed.error);
        return staffRefusal(parsed.data);
      }
      throw throttleOrServerError(res, what) ?? clientError(res.status, what);
    },

    async changeStaffRole(tournamentId, recordId, role) {
      const path = tournamentPaths.record(tournamentGuid(tournamentId), recordGuid(recordId));
      const what = 'Changing a staff role';
      const { res } = await writeJson('PATCH', path, [{ op: 'replace', path: '/role', value: staffRole(role) }], what);
      if (res.ok) return 'changed';
      if (res.status === 404) return 'not_found';
      throw throttleOrServerError(res, what) ?? clientError(res.status, what);
    },

    async unassignStaff(tournamentId, recordId, playerId) {
      const path = tournamentPaths.record(tournamentGuid(tournamentId), recordGuid(recordId));
      const what = 'Removing staff';
      // play-tools sends the staffer's player id as `legacy_alias` (S6 fixture 06).
      const { res } = await writeJson('DELETE', path, [{ legacy_alias: toPlayerId(playerId) }], what);
      if (res.ok) return 'removed';
      if (res.status === 404) return 'not_found';
      throw throttleOrServerError(res, what) ?? clientError(res.status, what);
    },

    async removeAttendance(groupId, sessionId, recordId) {
      if (!RECORD_ID.test(recordId)) throw new TypeError(`Not an attendance record id: ${JSON.stringify(recordId)}`);

      const what = 'Removing attendance';
      const token = await opts.tokens.getAccessToken(opts.leagueId);
      const res = await fetchUpstream(
        new URL(opPaths.record(groupId, sessionId, recordId), base).toString(),
        { method: 'DELETE', headers: { ...OP_API_HEADERS, authorization: `Bearer ${token.value}` } },
        what,
      );
      if (res.ok) return 'removed';
      if (res.status === 404) return 'not_found';
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

function toTournament(t: ActivityTournament): Tournament {
  const startsAt = t.start_date_v2 ? new Date(t.start_date_v2) : null;
  return {
    id: t.guid,
    name: t.name,
    displayId: t.display_id,
    groupId: t.activity_group?.guid ?? null,
    products: [t.product],
    startsAt,
    status: t.status,
    editableUntil: startsAt && new Date(startsAt.getTime() + STAFF_EDIT_WINDOW_MS),
  };
}

/** Oldest first, undated first, then by id. */
function byStart(a: Tournament, b: Tournament): number {
  const at = a.startsAt?.getTime() ?? -Infinity;
  const bt = b.startsAt?.getTime() ?? -Infinity;
  return at === bt ? a.id.localeCompare(b.id) : at - bt;
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

/** An assign refusal (S6): the first error under `participant.player_id`, or none for the staffer. */
function staffRefusal(error: OpErrorResponse): StaffAssignResult {
  const problem = error.errors?.body?.[STAFF_ERROR_FIELD]?.[0];
  if (!problem) return { status: 'invalid', code: shortCode(error.code) };
  const code = shortCode(problem.code);
  const suggested = code === 'merged_player_id' ? asPlayerId(problem.attributes?.actual_player_id) : undefined;
  return suggested ? { status: 'refused', code, suggestedPlayerId: suggested } : { status: 'refused', code };
}

/** `op.activity_record.missing_certification` → `missing_certification`. */
function shortCode(code: string): string {
  return code.replace(/^op\.[^.]+\./, '');
}

function asPlayerId(value: unknown): PlayerId | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  try {
    return toPlayerId(value);
  } catch {
    return undefined;
  }
}

function clientError(status: number, what: string): PokemonUpstreamError {
  if (status === 423) {
    return new PokemonUpstreamError('tournament_locked', `${what}: the tournament is past its edit window in play-tools.`, { status });
  }
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
