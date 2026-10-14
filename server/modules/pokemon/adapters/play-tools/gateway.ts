import type { z } from 'zod';
import { type Logger, silentLogger } from '@towerism/selfhost-kit';
import { PokemonUpstreamError, type UpstreamReply } from '../../ports/errors';
import { type PlayerId, toPlayerId } from '../../../../../shared/types/ids';
import type {
  AttendanceRecord,
  BulkResult,
  DateRange,
  Format,
  League,
  NewTournament,
  PlaySession,
  PlaySessionStatus,
  PlayToolsGateway,
  ProfessorProfile,
  ResultsError,
  ResultsUpload,
  Series,
  Tournament,
  TournamentDetails as TournamentDetailsPort,
  StaffAssignResult,
  StaffRoleCode,
  TournamentChanges,
  TournamentParticipant,
  Venue,
} from '../../ports/play-tools-gateway';
import type { TokenProvider } from '../../ports/token-provider';
import { fetchUpstream, jsonOrUndefined, throttleOrServerError } from '../http';
import { OP_API_BASE, OP_API_HEADERS, STAFF_ROLES, TDF_ERROR_MESSAGES, lifecyclePaths, opPaths, tournamentPaths } from './constants';
import {
  ActivitiesPage,
  AddressBookList,
  CreateTournamentResponse,
  ProductsResponse,
  ValidateResponse,
  cancelTournamentBody,
  confirmResultsBody,
  createTournamentBody,
  editTournamentBody,
  validateResultsBody,
  SeriesList,
  type TdfError,
  TournamentErrorResponse,
  UploadsList,
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
  /** The professor connection the calls are made as; null when the league has none, which fails each call with `not_connected`. */
  connectionId: number | null;
  /** Replaces `https://api.play.pokemon.com/services/` (test doubles only; `NUXT_POKEMON_API_URL`). */
  baseUrl?: string;
  log?: Pick<Logger, 'warn'>;
  /** How long a tournament or TDF write may take before it counts as `unavailable` (outcome unknown). Default 60 s. */
  writeTimeoutMs?: number;
}

const DEFAULT_WRITE_TIMEOUT_MS = 60_000;

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

/** A league, series, venue or upload guid, refused before any call if it could change the request path. */
function guidParam(id: string, what: string): string {
  if (!RECORD_ID.test(id)) throw new TypeError(`Not a ${what} id: ${JSON.stringify(id)}`);
  return id;
}

/** The id people see, e.g. `26-10-900041`; the TDF calls take it. */
function displayIdParam(displayId: string): string {
  if (!/^\d{2}-\d{2}-\d{6}$/.test(displayId)) throw new TypeError(`Not a tournament display id: ${JSON.stringify(displayId)}`);
  return displayId;
}

function countryParam(country: string): string {
  if (!/^[A-Z]{2}$/.test(country)) throw new TypeError(`Not a country code: ${JSON.stringify(country)}`);
  return country;
}

/**
 * The professor's user guid, hyphenated: the token's `sub` is the same id without hyphens (S8: `organizer_id` and the
 * address book take it hyphenated, the users path takes `sub` as it is).
 */
function userGuid(subject: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subject)) return subject;
  const hex = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/i.exec(subject);
  if (!hex) throw new PokemonUpstreamError('unexpected_shape', 'The Pokémon account id is not a user guid.');
  return hex.slice(1).join('-');
}

/** The venue, when the read's `address` (shape unrecorded, S8) is an object naming it. */
function venueOf(address: unknown): TournamentDetailsPort['venue'] {
  if (!address || typeof address !== 'object') return null;
  const { guid, timezone } = address as Record<string, unknown>;
  const id = typeof guid === 'string' && guid ? guid : null;
  const timeZone = typeof timezone === 'string' && timezone ? timezone : null;
  return id || timeZone ? { id, timeZone } : null;
}

/** A TDF error in readable words; a code play-tools doesn't explain is shown as it is. */
function resultsError(error: TdfError): ResultsError {
  const code = typeof error === 'string' ? error : error.type;
  const detail = typeof error === 'string' ? null : (error.message ?? null);
  return { code, message: TDF_ERROR_MESSAGES[code] ?? code, detail };
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
  const writeTimeoutMs = opts.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;

  function accessToken() {
    if (opts.connectionId === null) {
      return Promise.reject(new PokemonUpstreamError('not_connected', 'No Pokémon account submits for this league. Choose one in Settings.'));
    }
    return opts.tokens.getAccessToken(opts.connectionId);
  }

  async function get(url: URL, what: string): Promise<unknown> {
    const token = await accessToken();
    const res = await fetchUpstream(url.toString(), { headers: { ...OP_API_HEADERS, authorization: `Bearer ${token.value}` } }, what);
    if (res.ok) return jsonOrUndefined(res);
    throw throttleOrServerError(res, what) ?? clientError(res.status, what);
  }

  /** A JSON write with a fresh token; the caller reads the status. */
  async function writeJson(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    payload: unknown,
    what: string,
    signal?: AbortSignal,
  ): Promise<{ res: Response; url: URL }> {
    const token = await accessToken();
    const url = new URL(path, base);
    const res = await fetchUpstream(
      url.toString(),
      {
        method,
        headers: { ...OP_API_HEADERS, authorization: `Bearer ${token.value}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      },
      what,
    );
    return { res, url };
  }

  /**
   * A tournament or TDF write (S8): one request, never retried. Answers `{url, json}` for a 2xx, or for a status
   * `accept` takes as an answer; anything else throws.
   */
  async function lifecycleWrite(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    payload: unknown,
    what: string,
    accept: (res: Response, json: unknown) => boolean = () => false,
  ): Promise<{ url: URL; json: unknown }> {
    // A write that hangs may still land; `unavailable` tells the caller to re-read, never to resend blind.
    const { res, url } = await writeJson(method, path, payload, what, AbortSignal.timeout(writeTimeoutMs));
    const json = await jsonOrUndefined(res);
    if (res.ok || accept(res, json)) return { url, json };
    throw lifecycleError(res, json, what);
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
      const { subject } = await accessToken();
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

    async getProfessorProfile(): Promise<ProfessorProfile> {
      const what = 'Professor identity';
      const { subject } = await accessToken();
      const groups = await getAll(opPaths.userActivityGroups(subject), ActivityGroupsPage, what);
      const owner = groups.find((g) => g.group_type === 'personal')?.owner?.player_id;
      if (!owner || !/^\d{1,12}$/.test(owner)) {
        throw new PokemonUpstreamError('unexpected_shape', `${what}: the account's personal activity group has no owner player id.`);
      }
      return { playerId: toPlayerId(owner), name: null };
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
      const token = await accessToken();
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
      const registrationStart = t.registration_start_date_v2;
      const registrationEnd = t.registration_end_date_v2;
      return {
        ...toTournament({ ...t, activity_type: 'tournament', start_date_v2: t.start_date_v2 ?? t.start_date_actual ?? null }),
        organizerPlayerId: t.organizer.player_id as PlayerId,
        organizerName: [t.organizer.first_name, t.organizer.last_name].map((part) => part?.trim()).filter(Boolean).join(' ') || null,
        applicationState: t.application_state ?? null,
        activityState: t.activity_state ?? null,
        category: t.category ?? null,
        series: t.series ? { id: t.series.guid, name: t.series.name ?? null } : null,
        venue: venueOf(t.address),
        contact: { email: t.contact_information?.email ?? null, phone: t.contact_information?.phone ?? null },
        registration: registrationStart && registrationEnd ? { startsAt: new Date(registrationStart), endsAt: new Date(registrationEnd) } : null,
        onSiteAdmission: t.on_site_admission ?? null,
        thirdPartyRegistrationUrl: t.third_party_registration_website ?? null,
        details: t.details ?? null,
        eventWebsite: t.event_website ?? null,
      };
    },

    async listSeries(groupId): Promise<Series[]> {
      const group = guidParam(groupId, 'league');
      const { subject } = await accessToken();
      const series = await getAll(lifecyclePaths.series(subject, group), SeriesList, 'Premier series');
      return series
        .filter((s) => s.is_enabled !== false && (s.supported_types === undefined || s.supported_types.includes('tournament')))
        .map((s) => ({
          id: s.guid,
          name: s.name ?? '',
          product: s.product,
          categories: s.category_slugs,
          tags: s.tags ?? [],
          playTemplate: s.play_template ?? null,
          windows: Object.fromEntries(Object.entries(s.schedule ?? {}).map(([country, w]) => [country, { from: w.start_date, to: w.end_date }])),
        }));
    },

    async listFormats(country): Promise<Format[]> {
      const what = 'Formats';
      const url = new URL(`${lifecyclePaths.products()}?${new URLSearchParams({ country: countryParam(country) })}`, base);
      const body = await get(url, what);
      const parsed = ProductsResponse.safeParse(body);
      if (!parsed.success) throw unexpected(what, url, body, parsed.error);
      return parsed.data.results.map((product) => ({ product, categories: parsed.data.product_categories[product] ?? [] }));
    },

    async listVenues(groupId, country): Promise<Venue[]> {
      const query = new URLSearchParams({ country: countryParam(country), activity_group_id: guidParam(groupId, 'league') });
      const user = userGuid((await accessToken()).subject);
      const venues = await getAll(`${lifecyclePaths.addressBook(user)}?${query}`, AddressBookList, 'Venues');
      return venues.map((v) => ({
        id: v.guid,
        name: v.name ?? null,
        formattedAddress: v.formatted_address ?? null,
        country: v.op_country ?? v.country ?? null,
        timeZone: v.timezone ?? null,
      }));
    },

    async createTournament(tournament) {
      const what = 'Creating a tournament';
      checkNewTournament(tournament);
      const organizer = userGuid((await accessToken()).subject);
      const { url, json } = await lifecycleWrite('POST', lifecyclePaths.create(), createTournamentBody(tournament, organizer), what);
      const parsed = CreateTournamentResponse.safeParse(json);
      if (!parsed.success) throw unexpected(what, url, json, parsed.error);
      return { tournamentId: parsed.data.guid };
    },

    async editTournament(tournamentId, changes) {
      tournamentGuid(tournamentId);
      if (Object.values(changes).every((v) => v === undefined)) throw new TypeError('An edit needs at least one change.');
      checkSettings(changes);
      await lifecycleWrite('PATCH', lifecyclePaths.edit(tournamentGuid(tournamentId)), editTournamentBody(changes), 'Editing a tournament');
      return 'edited';
    },

    async cancelTournament(tournamentId) {
      await lifecycleWrite('PATCH', lifecyclePaths.edit(tournamentGuid(tournamentId)), cancelTournamentBody(), 'Cancelling a tournament');
      return 'cancelled';
    },

    async validateResults(displayId, tdf) {
      const what = 'Validating a TDF';
      displayIdParam(displayId);
      if (tdf.length === 0) throw new TypeError('A TDF to validate is empty.');
      // A validation that finds errors may answer 400 with the same body (unrecorded), so a 400 with an upload id is a result.
      const { url, json } = await lifecycleWrite('POST', lifecyclePaths.validate(), validateResultsBody(displayIdParam(displayId), tdf), what, (res, body) =>
        res.status === 400 && ValidateResponse.safeParse(body).success,
      );
      const parsed = ValidateResponse.safeParse(json);
      if (!parsed.success) throw unexpected(what, url, json, parsed.error);
      return { uploadId: parsed.data.upload_guid, errors: parsed.data.errors.map(resultsError) };
    },

    async confirmResults(uploadId, tournamentId) {
      const path = lifecyclePaths.confirm(guidParam(uploadId, 'upload'));
      await lifecycleWrite('PUT', path, confirmResultsBody(tournamentGuid(tournamentId)), 'Confirming a TDF');
      return 'confirmed';
    },

    async listResultsUploads(displayId): Promise<ResultsUpload[]> {
      const what = 'TDF uploads';
      const url = new URL(lifecyclePaths.uploads(displayIdParam(displayId)), base);
      const body = await get(url, what);
      const parsed = UploadsList.safeParse(body);
      if (!parsed.success) throw unexpected(what, url, body, parsed.error);
      return parsed.data
        .map((u) => ({ uploadId: u.guid, accepted: u.accepted, errors: u.errors.map(resultsError), uploadedAt: new Date(u.upload_timestamp) }))
        .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime());
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
      const token = await accessToken();
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
    applicationState: t.application_state ?? null,
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

/**
 * A failed tournament or TDF write (S8: no `op.*` codes on create, edit and cancel). Any 4xx without a more specific
 * meaning is `refused`. Every error carries what play-tools said, for the support details (ADR-0010 decision 7).
 */
function lifecycleError(res: Response, json: unknown, what: string): PokemonUpstreamError {
  const upstream = upstreamReply(res, json);
  const known = throttleOrServerError(res, what) ?? clientError(res.status, what);
  if (known.code === 'unexpected_shape') {
    const why = upstream.message ? `: ${upstream.message}` : ` (${res.status})`;
    return new PokemonUpstreamError('refused', `${what}: play-tools refused it${why}`, { status: res.status, upstream });
  }
  return new PokemonUpstreamError(known.code, known.message, { ...known.details, upstream });
}

/** play-tools' code and message (field errors appended) and the correlation id; never the request. */
function upstreamReply(res: Response, json: unknown): UpstreamReply {
  const parsed = TournamentErrorResponse.safeParse(json);
  const body = parsed.success ? parsed.data : {};
  const fields = fieldErrors(body.errors);
  const message = [body.message, fields.length > 0 ? `(${fields.join('; ')})` : undefined].filter(Boolean).join(' ');
  const correlationId = res.headers.get('x-correlation-id');
  return {
    ...(body.code ? { code: body.code } : {}),
    ...(message ? { message } : {}),
    ...(correlationId ? { correlationId } : {}),
  };
}

/** `{field: ["text"]}` (S8), or nested by location with `{code, message}` items (S6), as `field: text` lines. */
function fieldErrors(errors: unknown, prefix = ''): string[] {
  if (!errors || typeof errors !== 'object' || Array.isArray(errors)) return [];
  return Object.entries(errors).flatMap(([field, value]) => {
    if (!Array.isArray(value)) return fieldErrors(value, `${prefix}${field}.`);
    const texts = value
      .map((item: unknown) => (typeof item === 'string' ? item : (item as { message?: unknown; code?: unknown } | null)?.message ?? (item as { code?: unknown } | null)?.code))
      .filter((text): text is string => typeof text === 'string' && text !== '');
    return texts.length > 0 ? [`${prefix}${field}: ${texts.join(' ')}`] : [];
  });
}

const PRODUCTS: readonly string[] = ['tcg', 'vg', 'pgo'];
const NAME_MAX = 80;
const DETAILS_MAX = 30_000;

/** Checks a new tournament before anything is fetched or sent (play-tools' own limits, S8). */
function checkNewTournament(t: NewTournament): void {
  guidParam(t.groupId, 'league');
  if (!PRODUCTS.includes(t.product)) throw new TypeError(`Not a product: ${JSON.stringify(t.product)}`);
  if (t.seriesId !== null) guidParam(t.seriesId, 'series');
  checkSettings(t);
}

/** Checks whichever settings are given. */
function checkSettings(s: TournamentChanges): void {
  if (s.name !== undefined && (s.name.trim() === '' || s.name.length > NAME_MAX)) {
    throw new TypeError(`A tournament name has 1 to ${NAME_MAX} characters.`);
  }
  if (s.category !== undefined && !/^[a-z0-9_]{1,64}$/.test(s.category)) throw new TypeError(`Not a format: ${JSON.stringify(s.category)}`);
  if (s.venueId !== undefined) guidParam(s.venueId, 'venue');
  if (s.startsAt !== undefined) instant(s.startsAt, 'start');
  if (s.contact !== undefined && !s.contact.email && !s.contact.phone) throw new TypeError('A tournament needs a contact email or phone.');
  if (s.registration) {
    if (instant(s.registration.endsAt, 'registration end') <= instant(s.registration.startsAt, 'registration start')) {
      throw new TypeError('Registration must end after it starts.');
    }
  }
  if (s.details && s.details.length > DETAILS_MAX) throw new TypeError(`Tournament details have at most ${DETAILS_MAX} characters.`);
}

function instant(at: Date, what: string): number {
  const ms = at instanceof Date ? at.getTime() : Number.NaN;
  if (Number.isNaN(ms)) throw new TypeError(`Not a ${what} time.`);
  return ms;
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
