import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for access.pokemon.com (Hydra) and the OP API, run in the test
 * process. The app under test reaches it through `NUXT_POKEMON_ACCESS_URL` and
 * `NUXT_POKEMON_API_URL`, so server tests make no real network calls.
 *
 * It holds one Pokémon account per professor (`accounts`; the first is the
 * default). Like Hydra, each account's refresh token rotates on every refresh,
 * any token but the latest gets `invalid_grant`, and reusing a rotated token
 * revokes that account's chain.
 */
export interface FakePokemon {
  url: string;
  env: Record<string, string>;
  /**
   * Every request, in order, with when it arrived (ms since epoch), the form for token calls, the player ids of a
   * `_bulk`, and the player id of the account that authorised an OP API call (`as`).
   */
  requests: { method: string; path: string; at?: number; form?: Record<string, string>; playerIds?: string[]; body?: unknown; as?: string }[];
  /** The professors' accounts; `accounts[0]` is the default one, and any code no other account claims logs into it. */
  accounts: FakeAccount[];
  /** Adds a professor's account; log in as it by exchanging its `code`. */
  addAccount(opts: { playerId: string; name: string; leagues?: FakeLeague[] }): FakeAccount;
  /** Player ids whose chain was revoked because a rotated refresh token was reused (must stay empty). */
  reuseRevocations: string[];
  /** Every access and refresh token issued, for secret sweeps. */
  issuedTokens(): string[];
  /** Seconds; under 120 makes every access-token use refresh. */
  accessTtl: number;
  /** The default account's leagues. */
  leagues: FakeLeague[];
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
  /** Milliseconds to hold each read of a tournament's records (to keep a staff import running). */
  tournamentReadDelayMs: number;
  /** Tournament guids past their edit window: every write answers 423 `cannot_modify_old_activity`. */
  lockedTournaments: Set<string>;
  /**
   * Player id → the upstream code a staff assign for them is refused with (400), e.g. `op.activity_record.missing_certification`,
   * or the code with its attributes (`merged_player_id` names `actual_player_id`).
   */
  refuseStaff: Map<string, string | { code: string; attributes: Record<string, string> }>;
  /** Milliseconds to hold each staff assign (`POST …/records`) before answering (to stop a staff job mid-run). */
  staffPostDelayMs: number;
  /**
   * Path → status: the next request for that path answers it (e.g. 503), then the entry is cleared. With
   * `{ status, after }`, the first `after` requests go through and the one after them fails. A key
   * `path@playerId` fails only that professor's requests for the path.
   */
  failOnce: Map<string, number | { status: number; after: number }>;
  /** Path → the status and JSON body the next OP API request for that path answers (e.g. a 400 refusal), then cleared. */
  refuseOnce: Map<string, { status: number; body: unknown }>;
  /** Premier series every league offers, in the S8 `series/` item shape. */
  series: FakeSeries[];
  /** `core/products` for any country (S8 recording 06). */
  formats: { results: string[]; product_categories: Record<string, string[]> };
  /** Every professor's address book, in the S8 shape; the first is the league's own venue. */
  venues: FakeVenue[];
  /** Display id → the errors the next TDF validation for that tournament reports (`{type, message}` or a bare code), then cleared. */
  tdfErrors: Map<string, (string | { type: string; message: string })[]>;
  /**
   * The next create answers 500 but is stored hidden, as a create that lands after a gateway timeout does (ADR-0004
   * update, #100); `land()` reveals it. Cleared once used.
   */
  createLandsLate: boolean;
  /** Reveals the tournaments hidden by `createLandsLate`. */
  land(): void;
  /** Holds every create (after it is logged) until `release()`; `arrived` resolves when the first is held. */
  holdCreates(): { arrived: Promise<void>; release(): void };
  /** Holds every TDF validation (after it is logged) until `release()`, to stop the app mid-send (#96). */
  holdValidates(): { arrived: Promise<void>; release(): void };
  /** Every TDF a validation received, decoded from its base64 payload, in order (test oracle only). */
  validatedFiles: string[];
  /** Ends a confirmed upload's processing: `completed` makes the tournament `complete`; `upload_failed` leaves it sanctioned. */
  finishUpload(tournamentId: string, outcome: 'completed' | 'upload_failed'): void;
  /** Refuse the account's next refresh with `invalid_grant` (default account when no player id is given). */
  revokeChain(playerId?: string): void;
  liveRefreshToken(playerId?: string): string | undefined;
  /** The account's access token issued last (to prove it never reaches the app's log). */
  liveAccessToken(playerId?: string): string | undefined;
  close(): Promise<void>;
}

export const FAKE_SUB = '0123456789abcdef0123456789abcdef';
/** The default account's player id: the personal-group owner in the recorded S5 fixture. */
export const FAKE_PLAYER_ID = '9999991';

export interface FakeLeague {
  guid: string;
  display_id: string;
  display_name: string;
  canSubmit: boolean;
}

export interface FakeAccount {
  sub: string;
  playerId: string;
  name: string;
  /** The authorization code that logs into this account. */
  code: string;
  leagues: FakeLeague[];
}

interface AccountState extends FakeAccount {
  live?: string;
  liveAccess?: string;
  /** Refresh tokens this account has rotated away from; reusing one revokes the chain. */
  rotated: Set<string>;
}

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
  // The detail read's S8 fields; a `PATCH` sets them by their wire names.
  application_state: string;
  activity_state: string;
  category: string | null;
  series: { guid: string; name: string } | null;
  address: string | null;
  contact_information: { email: string | null; phone: string | null };
  registration_start_date_v2?: string | null;
  registration_end_date_v2?: string | null;
  on_site_admission?: string | null;
  third_party_registration_website?: string | null;
  details?: string | null;
  event_website?: string | null;
}

export interface FakeSeries {
  guid: string;
  name: string;
  product: string;
  category_slugs: string[];
  tags: string[];
  play_template: string | null;
  schedule: Record<string, { start_date: string; end_date: string }>;
}

export interface FakeVenue {
  guid: string;
  name: string;
  formatted_address: string;
  country: string;
  op_country: string;
  timezone: string;
}

interface FakeUpload {
  guid: string;
  tournament_id: string;
  kind: 'tdf';
  accepted: boolean;
  errors: (string | { type: string; message: string })[];
  uploader: string;
  upload_timestamp: number;
}

const STANDARD_FORMAT: Record<string, string> = { tcg: 'tcg_std', vg: 'vg_mod', pgo: 'pgo_std' };

/** The league's own venue in the default address book (S8 recording 08's shape, made-up values). */
export const FAKE_VENUE: FakeVenue = {
  guid: '00000000-0000-4000-8000-000000000051',
  name: 'Card Shop',
  formatted_address: '1 Main St',
  country: 'US',
  op_country: 'US',
  timezone: 'America/Chicago',
};

/** A tournament as `core/activities` lists it (S6). `startsAt` is true UTC; the wall clock is taken as UTC−5. */
export function fakeTournament(
  guid: string,
  opts: { startsAt?: string | null; groupId?: string; organizer?: string; status?: string; product?: string; name?: string; displayId?: string } = {},
): FakeTournament {
  const startsAt = opts.startsAt === undefined ? '2026-10-11T19:30:00Z' : opts.startsAt;
  const wallClock = startsAt ? new Date(Date.parse(startsAt) - 5 * 3_600_000) : new Date('2024-10-26T16:00:00Z');
  return {
    guid,
    activity_type: 'tournament',
    name: opts.name ?? `League Challenge ${guid}`,
    display_id: opts.displayId ?? `26-10-${guid}`,
    product: opts.product ?? 'tcg',
    start_date: wallClock.toISOString().replace('.000', ''),
    start_date_v2: startsAt,
    status: opts.status ?? 'sanctioned',
    activity_group: { guid: opts.groupId ?? 'group-1', group_type: 'league' },
    organizer: { player_id: opts.organizer ?? '9999991', first_name: 'Olive', last_name: 'Organizer' },
    application_state: opts.status === 'complete' ? 'sanctioned' : (opts.status ?? 'sanctioned'),
    activity_state: opts.status === 'complete' ? 'completed' : 'pending',
    category: STANDARD_FORMAT[opts.product ?? 'tcg'] ?? null,
    series: null,
    address: '1 Main St',
    contact_information: { email: 'league@example.com', phone: null },
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
// Tournament lifecycle and TDF (S8 part 2), exactly as recorded.
const TOURNAMENT_EDIT_PATH = /^\/services\/core\/tournament\/([^/]+)\/$/;
const SERIES_PATH = /^\/services\/core\/users\/([^/]+)\/activity_groups\/[^/]+\/series\/$/;
const ADDRESS_BOOK_PATH = /^\/services\/core\/v2\/users\/([^/]+)\/address_book$/;
const CONFIRM_PATH = /^\/services\/triumph\/([^/]+)\/confirm\/$/;
const UPLOADS_PATH = /^\/services\/triumph\/tournament\/([^/]+)\/uploads\/$/;
const TDF_FILE_PATH = /^\/services\/triumph\/tdf\/[^/]+$/;

/** A create or edit body onto a stored tournament, by wire name; dates move the wall-clock start and cancel the status with them. */
function applyTournamentFields(t: FakeTournament, sent: Record<string, unknown>): void {
  const settable = ['name', 'category', 'contact_information', 'registration_start_date_v2', 'registration_end_date_v2', 'on_site_admission',
    'third_party_registration_website', 'details', 'event_website'] as const;
  for (const key of settable) if (key in sent) (t as unknown as Record<string, unknown>)[key] = sent[key];
  if (typeof sent.start_date_v2 === 'string') {
    t.start_date_v2 = sent.start_date_v2;
    t.start_date = new Date(Date.parse(sent.start_date_v2) - 5 * 3_600_000).toISOString().replace('.000', '');
  }
  if (typeof sent.application_state === 'string') {
    t.application_state = sent.application_state;
    t.status = sent.application_state;
  }
}

export async function startFakePokemon(): Promise<FakePokemon> {
  let serial = 0;
  /** Creates `createLandsLate` stored but no read shows yet. */
  const hidden: FakeTournament[] = [];
  let createGate: { released: Promise<void>; arrive: () => void } | undefined;
  let validateGate: { released: Promise<void>; arrive: () => void } | undefined;
  const issued: string[] = [];
  const accounts: AccountState[] = [];
  const uploads: FakeUpload[] = [];
  const account = (playerId?: string) => (playerId === undefined ? accounts[0] : accounts.find((a) => a.playerId === playerId));

  const fake: Omit<FakePokemon, 'url' | 'env' | 'close'> = {
    requests: [],
    accounts,
    addAccount: ({ playerId, name, leagues = [] }) => {
      // A `sub` is a user guid without hyphens (S8), so the address book and create take it as the professor's id.
      const added: AccountState = { sub: playerId.padStart(32, '0'), playerId, name, code: `code-${playerId}`, leagues, rotated: new Set() };
      accounts.push(added);
      return added;
    },
    reuseRevocations: [],
    issuedTokens: () => [...issued],
    accessTtl: 3599,
    leagues: [{ guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true }],
    playSessions: [],
    records: new Map(),
    bulkDelayMs: 0,
    tournamentReadDelayMs: 0,
    dropOnce: new Set(),
    tournaments: [],
    tournamentRecords: new Map(),
    lockedTournaments: new Set(),
    refuseStaff: new Map(),
    staffPostDelayMs: 0,
    failOnce: new Map(),
    refuseOnce: new Map(),
    series: [],
    formats: {
      results: ['pgo', 'tcg', 'vg'],
      product_categories: {
        pgo: ['pgo_std', 'pgo_limited_meta', 'pgo_other'],
        tcg: ['tcg_std', 'tcg_exp', 'tcg_lim', 'tcg_lim_ditto', 'tcg_unl', 'tcg_glc', 'tcg_other'],
        vg: ['vg_mod', 'vg_fun_sin', 'vg_fun_multi', 'vg_fun_other'],
      },
    },
    venues: [FAKE_VENUE],
    tdfErrors: new Map(),
    createLandsLate: false,
    land: () => {
      fake.tournaments.push(...hidden.splice(0));
    },
    holdCreates: () => {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let arrive!: () => void;
      const arrived = new Promise<void>((r) => (arrive = r));
      createGate = { released, arrive };
      return {
        arrived,
        release: () => {
          createGate = undefined;
          release();
        },
      };
    },
    holdValidates: () => {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let arrive!: () => void;
      const arrived = new Promise<void>((r) => (arrive = r));
      validateGate = { released, arrive };
      return {
        arrived,
        release: () => {
          validateGate = undefined;
          release();
        },
      };
    },
    validatedFiles: [],
    finishUpload: (tournamentId, outcome) => {
      const t = fake.tournaments.find((x) => x.guid === tournamentId);
      if (!t) throw new Error(`fake: no tournament ${tournamentId}`);
      t.activity_state = outcome;
      if (outcome === 'completed') t.status = 'complete';
    },
    revokeChain: (playerId) => {
      const a = account(playerId);
      if (a) a.live = undefined;
    },
    liveRefreshToken: (playerId) => account(playerId)?.live,
    liveAccessToken: (playerId) => account(playerId)?.liveAccess,
  };
  // The default account: its leagues are `fake.leagues`, which tests replace wholesale.
  accounts.push({
    sub: FAKE_SUB,
    playerId: FAKE_PLAYER_ID,
    name: 'Olive Organizer',
    code: '',
    get leagues() {
      return fake.leagues;
    },
    set leagues(value) {
      fake.leagues = value;
    },
    rotated: new Set(),
  });

  function issue(res: ServerResponse, a: AccountState) {
    serial += 1;
    a.live = `ory_rt_${serial}`;
    const exp = Math.floor(Date.now() / 1000) + fake.accessTtl;
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    a.liveAccess = `${enc({ alg: 'RS256' })}.${enc({ sub: a.sub, exp, jti: String(serial) })}.sig`;
    issued.push(a.live, a.liveAccess);
    json(res, 200, { access_token: a.liveAccess, token_type: 'bearer', expires_in: fake.accessTtl, refresh_token: a.live, scope: 'openid organized_play offline' });
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const entry: FakePokemon['requests'][number] = { method: req.method ?? '', path: url.pathname, at: Date.now() };
    fake.requests.push(entry);

    const failure = fake.failOnce.get(url.pathname);
    if (typeof failure === 'object' && failure.after > 0) {
      fake.failOnce.set(url.pathname, { ...failure, after: failure.after - 1 });
    } else if (failure) {
      fake.failOnce.delete(url.pathname);
      return json(res, typeof failure === 'object' ? failure.status : failure, { code: 'op.generic.unavailable' });
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      const form = Object.fromEntries(new URLSearchParams(await body(req)));
      entry.form = form;
      if (form.client_id !== 'op-tools-app') return json(res, 401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        if (!form.code || !form.code_verifier) return json(res, 400, { error: 'invalid_request' });
        if (form.code === 'used') return json(res, 400, { error: 'invalid_grant', error_description: 'The authorization code has already been used.' });
        return issue(res, accounts.find((a) => a.code && a.code === form.code) ?? accounts[0]!);
      }
      if (form.grant_type === 'refresh_token') {
        const owner = accounts.find((a) => a.live && a.live === form.refresh_token);
        if (owner) {
          owner.rotated.add(owner.live!);
          return issue(res, owner);
        }
        const reused = accounts.find((a) => a.rotated.has(form.refresh_token ?? ''));
        if (reused) {
          reused.live = undefined;
          reused.liveAccess = undefined;
          fake.reuseRevocations.push(reused.playerId);
        }
        return json(res, 400, { error: 'invalid_grant', error_description: 'The refresh token is not valid.' });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    if (req.method === 'POST' && url.pathname === '/oauth2/revoke') {
      entry.form = Object.fromEntries(new URLSearchParams(await body(req)));
      const owner = accounts.find((a) => a.live && a.live === entry.form!.token);
      if (owner) owner.live = undefined;
      res.writeHead(200).end();
      return;
    }

    const caller = accounts.find((a) => a.liveAccess && req.headers.authorization === `Bearer ${a.liveAccess}`);
    if (url.pathname.startsWith('/services/')) {
      if (!caller) return json(res, 401, { code: 'op.generic.unauthorized', message: 'Request is not authenticated for the request.' });
      entry.as = caller.playerId;
      const key = `${url.pathname}@${caller.playerId}`;
      const own = fake.failOnce.get(key);
      if (typeof own === 'object' && own.after > 0) {
        fake.failOnce.set(key, { ...own, after: own.after - 1 });
      } else if (own) {
        fake.failOnce.delete(key);
        return json(res, typeof own === 'object' ? own.status : own, { code: 'op.generic.unavailable' });
      }
      const refusal = fake.refuseOnce.get(url.pathname);
      if (refusal) {
        fake.refuseOnce.delete(url.pathname);
        return json(res, refusal.status, refusal.body);
      }
      // Play sessions belong to a league; only its staff may touch them.
      const group = /^\/services\/core\/activity_groups\/([^/]+)\//.exec(url.pathname)?.[1];
      if (group && !caller.leagues.some((l) => l.guid === group)) {
        return json(res, 403, { code: 'op.generic.permission_denied', message: 'You do not have permission to perform this action.' });
      }
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

    // S6: the caller's own tournaments (`role=organizer`), any activity group, newest first by the wall-clock start.
    // Date filters are ignored, as upstream does; `page`/`page_size` page with absolute `next` links.
    if (req.method === 'GET' && url.pathname === '/services/core/activities') {
      const all = fake.tournaments
        .filter((t) => url.searchParams.get('type') === 'tournament' && t.organizer.player_id === caller?.playerId)
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
      // S6: staff management is organizer-only; anyone else gets 403.
      const organizer = fake.tournaments.find((x) => x.guid === tournamentId)?.organizer.player_id;
      if (organizer && organizer !== caller?.playerId) {
        return json(res, 403, { code: 'op.generic.permission_denied', message: 'You do not have permission to perform this action.' });
      }
      if (req.method === 'GET' && tRecordsMatch) {
        if (fake.tournamentReadDelayMs) await new Promise((r) => setTimeout(r, fake.tournamentReadDelayMs));
        // Spike #67: play-tools lists a tournament from a league the account has left, but refuses its records.
        const group = fake.tournaments.find((x) => x.guid === tournamentId)?.activity_group?.guid;
        if (group && !caller?.leagues.some((l) => l.guid === group)) {
          return json(res, 403, {
            code: 'op.activity_group.criteria_failure',
            message: 'The requested action could not be performed due to insufficient access.',
          });
        }
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

    // S8: create. 201 {guid}; `activity_division_info: null` is refused by field; the league must be the caller's.
    if (req.method === 'POST' && caller && url.pathname === '/services/core/tournament') {
      const sent = JSON.parse(await body(req)) as Record<string, unknown>;
      entry.body = sent;
      if (sent.activity_division_info == null) {
        return json(res, 400, { code: 'op.generic.bad_request', message: 'Invalid request.', errors: { activity_division_info: ['This field may not be null.'] } });
      }
      if (!caller.leagues.some((l) => l.guid === sent.activity_group_id)) {
        return json(res, 403, { code: 'op.generic.forbidden', message: 'Request not authorized for attempted action.' });
      }
      const guid = `t-${++serial}`;
      const [first = '', last = ''] = caller.name.split(' ');
      const created: FakeTournament = {
        ...fakeTournament(guid, {
          startsAt: sent.start_date_v2 as string,
          groupId: sent.activity_group_id as string,
          organizer: caller.playerId,
          product: sent.product as string,
          name: sent.name as string,
        }),
        display_id: `26-10-${900000 + serial}`,
        organizer: { player_id: caller.playerId, first_name: first, last_name: last },
        series: (() => {
          const s = fake.series.find((x) => x.guid === sent.series_guid);
          return s ? { guid: s.guid, name: s.name } : null;
        })(),
        address: fake.venues.find((v) => v.guid === sent.address_id)?.formatted_address ?? null,
      };
      applyTournamentFields(created, sent);
      if (createGate) {
        createGate.arrive();
        await createGate.released;
      }
      if (fake.createLandsLate) {
        fake.createLandsLate = false;
        hidden.push(created);
        return json(res, 500, { code: 'op.generic.server_error', message: 'Internal server error.' });
      }
      fake.tournaments.push(created);
      return json(res, 201, { guid });
    }

    // S8: edit and cancel are a partial PATCH that changes only the fields sent; 204, empty.
    const editMatch = TOURNAMENT_EDIT_PATH.exec(url.pathname);
    if (req.method === 'PATCH' && editMatch) {
      const t = fake.tournaments.find((x) => x.guid === editMatch[1]);
      const raw = await body(req);
      entry.body = raw ? (JSON.parse(raw) as unknown) : undefined;
      if (!t) return json(res, 404, { code: 'op.generic.not_found' });
      if (t.organizer.player_id !== caller?.playerId) {
        return json(res, 403, { code: 'op.generic.forbidden', message: 'Request not authorized for attempted action.' });
      }
      if (fake.lockedTournaments.has(t.guid)) {
        return json(res, 423, { code: 'op.activity.cannot_modify_old_activity', message: 'The given activity is no longer modifiable.' });
      }
      applyTournamentFields(t, entry.body as Record<string, unknown>);
      res.writeHead(204).end();
      return;
    }

    const seriesMatch = SERIES_PATH.exec(url.pathname);
    if (req.method === 'GET' && caller && seriesMatch && seriesMatch[1] === caller.sub) {
      return json(res, 200, { results: fake.series });
    }

    if (req.method === 'GET' && url.pathname === '/services/core/products') {
      if (!url.searchParams.get('country')) return json(res, 400, { code: 'op.generic.bad_request', message: 'Invalid request.' });
      return json(res, 200, fake.formats);
    }

    // S8: the address book is the professor's own, by their user guid (the `sub`, hyphenated).
    const bookMatch = ADDRESS_BOOK_PATH.exec(url.pathname);
    if (req.method === 'GET' && caller && bookMatch) {
      if (bookMatch[1]!.replaceAll('-', '') !== caller.sub) return json(res, 403, { code: 'op.generic.forbidden' });
      return json(res, 200, { results: fake.venues });
    }

    // S8: validate answers a preview with the file's errors; the upload is listed straight away, not yet accepted.
    if (req.method === 'POST' && caller && url.pathname === '/services/triumph/tdf/') {
      const sent = JSON.parse(await body(req)) as { kind: string; tournament_id: string; payload: string };
      entry.body = { ...sent, payload: '<tdf>' };
      fake.validatedFiles.push(Buffer.from(sent.payload, 'base64').toString('utf8'));
      if (validateGate) {
        validateGate.arrive();
        await validateGate.released;
      }
      const t = fake.tournaments.find((x) => x.display_id === sent.tournament_id);
      if (!t) return json(res, 400, { code: 'op.generic.bad_request', message: 'Invalid request.' });
      const errors = fake.tdfErrors.get(sent.tournament_id) ?? [];
      fake.tdfErrors.delete(sent.tournament_id);
      const upload: FakeUpload = {
        guid: `upload-${++serial}`,
        tournament_id: sent.tournament_id,
        kind: 'tdf',
        accepted: false,
        errors,
        uploader: caller.sub,
        upload_timestamp: Date.now(),
      };
      uploads.push(upload);
      return json(res, 200, { name: t.name, id: t.display_id, upload_guid: upload.guid, player_count: 0, start_date: '', product: 'TRADING_CARD_GAME', errors });
    }

    // S8: confirm takes the tournament guid; 202, and processing runs until `finishUpload`.
    const confirmMatch = CONFIRM_PATH.exec(url.pathname);
    if (req.method === 'PUT' && confirmMatch) {
      entry.body = JSON.parse(await body(req)) as unknown;
      const upload = uploads.find((u) => u.guid === confirmMatch[1]);
      const t = fake.tournaments.find((x) => x.guid === (entry.body as { tournament_id?: string }).tournament_id);
      if (!upload || !t || t.display_id !== upload.tournament_id) return json(res, 400, { code: 'op.generic.bad_request', message: 'Invalid request.' });
      upload.accepted = true;
      t.activity_state = 'upload_in_progress';
      res.writeHead(202).end();
      return;
    }

    const uploadsMatch = UPLOADS_PATH.exec(url.pathname);
    if (req.method === 'GET' && uploadsMatch) {
      return json(res, 200, uploads.filter((u) => u.tournament_id === uploadsMatch[1]));
    }

    // S8: an organizer can't fetch a TDF back (#107).
    if (req.method === 'GET' && TDF_FILE_PATH.test(url.pathname)) {
      return json(res, 403, { code: 'op.generic.forbidden', message: 'Request not authorized for attempted action.' });
    }

    if (req.method === 'GET' && caller && url.pathname === `/services/core/users/${caller.sub}/activity_groups/`) {
      const results = [
        {
          guid: `personal-${caller.playerId}`,
          display_id: null,
          group_type: 'personal',
          name: null,
          display_name: null,
          owner: { guid: `owner-${caller.playerId}`, player_id: caller.playerId },
        },
        ...caller.leagues.map((l) => ({
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

let correlations = 0;

/** A JSON answer with an `x-correlation-id`, as the OP gateway sends (the support details carry it, ADR-0010 decision 7). */
function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-correlation-id': `fake-${++correlations}` }).end(JSON.stringify(payload));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
