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
  /** Every request, in order: `METHOD /path` plus the form for token calls. */
  requests: { method: string; path: string; form?: Record<string, string> }[];
  /** Seconds; under 120 makes every access-token use refresh. */
  accessTtl: number;
  leagues: { guid: string; display_id: string; display_name: string; canSubmit: boolean }[];
  /** Play sessions of every league, in the S3 wire shape; filtered by the status and start-date query. */
  playSessions: FakePlaySession[];
  /** Attendance records per play session, in the S3 wire shape. */
  records: Map<string, FakeRecord[]>;
  /** Milliseconds to hold each `_bulk` response (to stop the app mid-job). */
  bulkDelayMs: number;
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
const BULK_PATH = /^\/services\/core\/activity_groups\/([^/]+)\/play_sessions\/([^/]+)\/records\/_bulk\/$/;

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
    const entry: FakePokemon['requests'][number] = { method: req.method ?? '', path: url.pathname };
    fake.requests.push(entry);

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
      fake.records.set(bulkMatch[2]!, [...records, ...added]);
      return json(res, 201, added.map((r) => ({ guid: r.guid })));
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
