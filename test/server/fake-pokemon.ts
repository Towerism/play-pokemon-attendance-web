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
  /** Refuse the next refresh with `invalid_grant`. */
  revokeChain(): void;
  liveRefreshToken(): string | undefined;
  close(): Promise<void>;
}

export const FAKE_SUB = '0123456789abcdef0123456789abcdef';

export async function startFakePokemon(): Promise<FakePokemon> {
  let serial = 0;
  let live: string | undefined;
  let liveAccess: string | undefined;

  const fake: Omit<FakePokemon, 'url' | 'env' | 'close'> = {
    requests: [],
    accessTtl: 3599,
    leagues: [{ guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true }],
    revokeChain: () => (live = undefined),
    liveRefreshToken: () => live,
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

    if (req.method === 'GET' && url.pathname === `/services/core/users/${FAKE_SUB}/activity_groups/`) {
      if (!liveAccess || req.headers.authorization !== `Bearer ${liveAccess}`) {
        return json(res, 401, { code: 'op.generic.unauthorized', message: 'Request is not authenticated for the request.' });
      }
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
