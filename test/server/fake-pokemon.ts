import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for access.pokemon.com (Hydra) and the OP API, run in the test
 * process. The app under test reaches it through `NUXT_POKEMON_ACCESS_URL` and
 * `NUXT_POKEMON_API_URL`, so server tests make no real network calls.
 *
 * Like Hydra, it rotates the refresh token on every refresh and refuses any
 * token but the latest with `invalid_grant`.
 */
export interface FakePokemon {
  url: string;
  env: Record<string, string>;
  /** Every request, in order, with when it arrived (ms since epoch), the form for token calls and the player ids of a `_bulk`. */
  requests: { method: string; path: string; at?: number; form?: Record<string, string>; playerIds?: string[]; body?: unknown }[];
  /** Seconds; under 120 makes every access-token use refresh. */
  accessTtl: number;
  leagues: { guid: string; display_id: string; display_name: string; canSubmit: boolean }[];
  /** Play sessions of every league, in the S3 wire shape; filtered by the status and start-date query. */
  playSessions: FakePlaySession[];
  /** Attendance records per play session, in the S3 wire shape. */
  records: Map<string, FakeRecord[]>;
  /** Milliseconds to hold each `_bulk` response (to stop the app mid-job). */
  bulkDelayMs: number;
  /** The next `_bulk` answers 201 for everyone but doesn't store these ids (a record that never sticks); then cleared. */
  dropOnce: Set<string>;
  /** Tournaments the account organizes (any activity group), in the S6 `core/activities` shape plus their organizer. */
  tournaments: FakeTournament[];
  /** Everyone on each tournament (players and staff, the organizer record too), by tournament guid. */
  tournamentRecords: Map<string, FakeRecord[]>;
  /** Tournament guids past their edit window: every write answers 423 `cannot_modify_old_activity`. */
  lockedTournaments: Set<string>;
  /**
   * Player id → the upstream code a staff assign for them is refused with (400), e.g. `op.activity_record.missing_certification`,
   * or the code with its attributes (`merged_player_id` names `actual_player_id`).
   */
  refuseStaff: Map<string, string | { code: string; attributes: Record<string, string> }>;
  /** Milliseconds to hold each staff assign (`POST …/records`) before answering (to stop a staff job mid-run). */
  staffPostDelayMs: number;
  /** Path → status: the next request for that path answers it (e.g. 503), then the entry is cleared. */
  failOnce: Map<string, number>;
  /** Refuse the next refresh with `invalid_grant`. */
  revokeChain(): void;
  liveRefreshToken(): string | undefined;
  /** The access token issued last (to prove it never reaches the app's log). */
  liveAccessToken(): string | undefined;
  close(): Promise<void>;
}

export const FAKE_SUB = '0123456789abcdef0123456789abcdef';

export interface FakePlaySession {
  guid: string;
  type: string;
  status: 'active' | 'pending' | 'complete';
  start_date: string;
  end_date: string | null;
  final_modifiable_datetime: string | null;
  products: string[];
}

export interface FakeTournament {
  guid: string;
  activity_type: 'tournament';
  name: string | null;
  display_id: string;
  product: string;
  /** Local wall-clock time stamped Z, as upstream sends it (S6); only used for ordering. */
  start_date: string;
  start_date_v2: string | null;
  status: string;
  activity_group: { guid: string; group_type: 'league' } | null;
  organizer: { player_id: string; first_name: string; last_name: string };
}

/** A tournament as `core/activities` lists it (S6). `startsAt` is true UTC; the wall clock is taken as UTC−5. */
export function fakeTournament(
  guid: string,
  opts: { startsAt?: string | null; groupId?: string; organizer?: string; status?: string; product?: string; name?: string } = {},
): FakeTournament {
  const startsAt = opts.startsAt === undefined ? '2026-10-11T19:30:00Z' : opts.startsAt;
  const wallClock = startsAt ? new Date(Date.parse(startsAt) - 5 * 3_600_000) : new Date('2024-10-26T16:00:00Z');
  return {
    guid,
    activity_type: 'tournament',
    name: opts.name ?? `League Challenge ${guid}`,
    display_id: `26-10-${guid}`,
    product: opts.product ?? 'tcg',
    start_date: wallClock.toISOString().replace('.000', ''),
    start_date_v2: startsAt,
    status: opts.status ?? 'sanctioned',
    activity_group: { guid: opts.groupId ?? 'group-1', group_type: 'league' },
    organizer: { player_id: opts.organizer ?? '9999991', first_name: 'Olive', last_name: 'Organizer' },
  };
}

export interface FakeRecord {
  guid: string;
  role: string | null;
  player: boolean;
  origin: string;
  updated: string;
  participant: { guid: string; player_id: string; display_first_name: string | null; display_last_name: string | null };
}

/** A record as play-tools lists it (S3); staff records have a role and `player: false` (S4). */
export function fakeRecord(playerId: string, opts: { role?: string; first?: string; last?: string; guid?: string } = {}): FakeRecord {
  return {
    guid: opts.guid ?? `rec-${playerId}`,
    role: opts.role ?? null,
    player: !opts.role,
    origin: opts.role ? 'unknown' : 'roster',
    updated: new Date().toISOString(),
    participant: { guid: `p-${playerId}`, player_id: playerId, display_first_name: opts.first ?? null, display_last_name: opts.last ?? null },
  };
}

const SESSIONS_PATH = /^\/services\/core\/activity_groups\/([^/]+)\/play_sessions\/$/;
const RECORDS_PATH = /^\/services\/core\/activity_groups\/([^/]+)\/play_sessions\/([^/]+)\/records\/$/;
const RECORD_PATH = /^\/services\/core\/activity_groups\/([^/]+)\/play_sessions\/([^/]+)\/records\/([^/]+)\/$/;
const BULK_PATH = /^\/services\/core\/activity_groups\/([^/]+)\/play_sessions\/([^/]+)\/records\/_bulk\/$/;
// Tournaments (S6): recorded without a trailing slash.
const TOURNAMENT_PATH = /^\/services\/core\/tournament\/([^/]+)$/;
const T_RECORDS_PATH = /^\/services\/core\/tournaments\/([^/]+)\/records$/;
const T_RECORD_PATH = /^\/services\/core\/tournaments\/([^/]+)\/records\/([^/]+)$/;

export async function startFakePokemon(): Promise<FakePokemon> {
  let serial = 0;
  let live: string | undefined;
  let liveAccess: string | undefined;

  const fake: Omit<FakePokemon, 'url' | 'env' | 'close'> = {
    requests: [],
    accessTtl: 3599,
    leagues: [{ guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true }],
    playSessions: [],
    records: new Map(),
    bulkDelayMs: 0,
    dropOnce: new Set(),
    tournaments: [],
    tournamentRecords: new Map(),
    lockedTournaments: new Set(),
    refuseStaff: new Map(),
    staffPostDelayMs: 0,
    failOnce: new Map(),
    revokeChain: () => (live = undefined),
    liveRefreshToken: () => live,
    liveAccessToken: () => liveAccess,
  };

  function issue(res: ServerResponse) {
    serial += 1;
    live = `ory_rt_${serial}`;
    const exp = Math.floor(Date.now() / 1000) + fake.accessTtl;
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    liveAccess = `${enc({ alg: 'RS256' })}.${enc({ sub: FAKE_SUB, exp, jti: String(serial) })}.sig`;
    json(res, 200, { access_token: liveAccess, token_type: 'bearer', expires_in: fake.accessTtl, refresh_token: live, scope: 'openid organized_play offline' });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const entry: FakePokemon['requests'][number] = { method: req.method ?? '', path: url.pathname, at: Date.now() };
    fake.requests.push(entry);

    const failure = fake.failOnce.get(url.pathname);
    if (failure) {
      fake.failOnce.delete(url.pathname);
      return json(res, failure, { code: 'op.generic.unavailable' });
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      const form = Object.fromEntries(new URLSearchParams(await body(req)));
      entry.form = form;
      if (form.client_id !== 'op-tools-app') return json(res, 401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        if (!form.code || !form.code_verifier) return json(res, 400, { error: 'invalid_request' });
        if (form.code === 'used') return json(res, 400, { error: 'invalid_grant', error_description: 'The authorization code has already been used.' });
        return issue(res);
      }
      if (form.grant_type === 'refresh_token') {
        if (!live || form.refresh_token !== live) return json(res, 400, { error: 'invalid_grant', error_description: 'The refresh token is not valid.' });
        return issue(res);
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/revoke') {
      entry.form = Object.fromEntries(new URLSearchParams(await body(req)));
      if (entry.form.token === live) live = undefined;
      res.writeHead(200).end();
      return;
    }

    if (url.pathname.startsWith('/services/') && (!liveAccess || req.headers.authorization !== `Bearer ${liveAccess}`)) {
      return json(res, 401, { code: 'op.generic.unauthorized', message: 'Request is not authenticated for the request.' });
    }

    const sessionsMatch = SESSIONS_PATH.exec(url.pathname);
    if (req.method === 'GET' && sessionsMatch) {
      const q = url.searchParams;
      if (!['active', 'pending', 'complete'].includes(q.get('status') ?? '')) return json(res, 400, { code: 'op.value.invalid_choice' });
      const gte = Date.parse(q.get('start_date:greater_than_or_equal_to') ?? '');
      const lte = Date.parse(q.get('start_date:less_than_or_equal_to') ?? '');
      const results = fake.playSessions.filter(
        (s) => s.status === q.get('status') && Date.parse(s.start_date) >= gte && Date.parse(s.start_date) <= lte,
      );
      return json(res, 200, { count: results.length, next: null, previous: null, results });
    }

    const recordsMatch = RECORDS_PATH.exec(url.pathname);
    if (req.method === 'GET' && recordsMatch) {
      const all = fake.records.get(recordsMatch[2]!) ?? [];
      const results = url.searchParams.get('player') === 'true' ? all.filter((r) => r.player) : all;
      return json(res, 200, { count: results.length, next: null, previous: null, results });
    }

    const bulkMatch = BULK_PATH.exec(url.pathname);
    if (req.method === 'POST' && bulkMatch) {
      const items = JSON.parse(await body(req)) as { participant: { player_id: string } }[];
      entry.playerIds = items.map((i) => i.participant.player_id);
      if (fake.bulkDelayMs) await new Promise((r) => setTimeout(r, fake.bulkDelayMs));
      // S4: a malformed id fails the whole request with an HTML 500.
      if (items.some((i) => !/^\d+$/.test(i.participant.player_id))) {
        res.writeHead(500, { 'content-type': 'text/html' }).end('<h1>Server Error (500)</h1>');
        return;
      }
      const records = fake.records.get(bulkMatch[2]!) ?? [];
      // S4: all-or-nothing; a participant already holding a record (any role) is refused, keyed by index.
      const dupes = Object.fromEntries(
        items
          .map((item, i) => [i, item.participant.player_id] as const)
          .filter(([, playerId]) => records.some((r) => r.participant.player_id === playerId))
          .map(([i]) => [`${i}.participant.player_id`, [{ code: 'op.activity_record.cannot_duplicate_participant' }]]),
      );
      if (Object.keys(dupes).length > 0) {
        return json(res, 400, { code: 'op.generic.bad_request', message: 'Invalid request.', errors: { body: dupes } });
      }
      const added = items.map((i) => fakeRecord(i.participant.player_id, { guid: `rec-${++serial}` }));
      const dropped = fake.dropOnce;
      fake.dropOnce = new Set();
      fake.records.set(bulkMatch[2]!, [...records, ...added.filter((r) => !dropped.has(r.participant.player_id))]);
      return json(res, 201, added.map((r) => ({ guid: r.guid })));
    }

    // S4: DELETE one record → 204; a record it doesn't have → 404.
    const recordMatch = RECORD_PATH.exec(url.pathname);
    if (req.method === 'DELETE' && recordMatch && recordMatch[3] !== '_bulk') {
      const records = fake.records.get(recordMatch[2]!) ?? [];
      const kept = records.filter((r) => r.guid !== recordMatch[3]);
      if (kept.length === records.length) return json(res, 404, { code: 'op.generic.not_found' });
      fake.records.set(recordMatch[2]!, kept);
      res.writeHead(204).end();
      return;
    }

    // S6: the organizer's tournaments, any activity group, newest first by the wall-clock start.
    // Date filters are ignored, as upstream does; `page`/`page_size` page with absolute `next` links.
    if (req.method === 'GET' && url.pathname === '/services/core/activities') {
      const all = fake.tournaments
        .filter(() => url.searchParams.get('type') === 'tournament')
        .map(({ organizer: _organizer, ...row }) => row)
        .sort((a, b) => b.start_date.localeCompare(a.start_date));
      return json(res, 200, paged(all, url, req));
    }

    const tournamentMatch = TOURNAMENT_PATH.exec(url.pathname);
    if (req.method === 'GET' && tournamentMatch) {
      const t = fake.tournaments.find((x) => x.guid === tournamentMatch[1]);
      if (!t) return json(res, 404, { code: 'op.generic.not_found' });
      return json(res, 200, { ...t, start_date_actual: t.start_date_v2, organizer: { guid: 'org', country: 'US', display_name: null, ...t.organizer } });
    }

    const tRecordsMatch = T_RECORDS_PATH.exec(url.pathname);
    const tRecordMatch = T_RECORD_PATH.exec(url.pathname);
    const tournamentId = tRecordsMatch?.[1] ?? tRecordMatch?.[1];
    if (tournamentId) {
      const records = fake.tournamentRecords.get(tournamentId) ?? [];
      if (req.method === 'GET' && tRecordsMatch) {
        const player = url.searchParams.get('player');
        const shown = player === null ? records : records.filter((r) => r.player === (player === 'true'));
        // Real records also carry the birth year (S6); the adapter must drop it.
        return json(res, 200, paged(shown.map((r) => ({ ...r, participant: { ...r.participant, year_of_birth: 2010 } })), url, req));
      }
      if (req.method !== 'GET') {
        const raw = await body(req);
        entry.body = raw ? (JSON.parse(raw) as unknown) : undefined;
        if (fake.lockedTournaments.has(tournamentId)) {
          return json(res, 423, { code: 'op.activity.cannot_modify_old_activity', message: 'The given activity is no longer modifiable.' });
        }
      }
      if (req.method === 'POST' && tRecordsMatch) {
        const { role, participant } = entry.body as { role: string; participant: { player_id: string } };
        const refusal = records.some((r) => r.participant.player_id === participant.player_id)
          ? 'op.activity_record.cannot_duplicate_participant'
          : fake.refuseStaff.get(participant.player_id);
        if (fake.staffPostDelayMs) await new Promise((r) => setTimeout(r, fake.staffPostDelayMs));
        if (refusal) {
          const problem = typeof refusal === 'string' ? { code: refusal } : refusal;
          return json(res, 400, { code: 'op.generic.bad_request', message: 'Invalid request.', errors: { body: { 'participant.player_id': [problem] } } });
        }
        const record = { ...fakeRecord(participant.player_id, { role, guid: `staff-${++serial}` }), origin: 'manual' };
        fake.tournamentRecords.set(tournamentId, [...records, record]);
        return json(res, 201, { guid: record.guid });
      }
      if ((req.method === 'PATCH' || req.method === 'DELETE') && tRecordMatch) {
        const record = records.find((r) => r.guid === tRecordMatch[2]);
        if (!record) return json(res, 404, { code: 'op.generic.not_found' });
        if (req.method === 'PATCH') {
          const [op] = entry.body as { op: string; path: string; value: string }[];
          if (op?.op === 'replace' && op.path === '/role') record.role = op.value;
        } else {
          fake.tournamentRecords.set(tournamentId, records.filter((r) => r !== record));
        }
        res.writeHead(204).end();
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === `/services/core/users/${FAKE_SUB}/activity_groups/`) {
      const results = [
        { guid: 'personal-1', display_id: null, group_type: 'personal', name: null, display_name: null },
        ...fake.leagues.map((l) => ({
          guid: l.guid,
          display_id: l.display_id,
          group_type: 'league',
          name: null,
          display_name: l.display_name,
          criteria: { play_sessions: { create_attendance: l.canSubmit } },
        })),
      ];
      return json(res, 200, { count: results.length, next: null, previous: null, results });
    }

    json(res, 404, { code: 'op.generic.not_found' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    url,
    env: { NUXT_POKEMON_ACCESS_URL: `${url}/`, NUXT_POKEMON_API_URL: `${url}/services/` },
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}

/** A DRF page of `items` for the request's `page`/`page_size` (default 100), with an absolute `next` link. */
function paged<T>(items: T[], url: URL, req: IncomingMessage) {
  const size = Number(url.searchParams.get('page_size') ?? '100');
  const n = Number(url.searchParams.get('page') ?? '1');
  const results = items.slice((n - 1) * size, n * size);
  let next: string | null = null;
  if (n * size < items.length) {
    const nextUrl = new URL(`${url.pathname}${url.search}`, `http://${req.headers.host}`);
    nextUrl.searchParams.set('page', String(n + 1));
    next = nextUrl.toString();
  }
  return { count: items.length, next, previous: null, results };
}

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
