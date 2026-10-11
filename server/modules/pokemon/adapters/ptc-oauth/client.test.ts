import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PokemonUpstreamError } from '../../ports/errors';
import { fakeAccessToken } from '../../test-helpers';
import { createPtcOAuthClient } from './client';

const TOKEN_URL = 'https://access.pokemon.com/oauth2/token';
const NOW = new Date('2026-10-14T23:00:00Z');
const SUB = '0123456789abcdef0123456789abcdef';
const ACCESS = fakeAccessToken({ sub: SUB, exp: NOW.getTime() / 1000 + 3600 });

const upstream = setupServer();
beforeAll(() => upstream.listen({ onUnhandledRequest: 'error' }));
afterEach(() => upstream.resetHandlers());
afterAll(() => upstream.close());

const client = () => createPtcOAuthClient({ now: () => NOW });

/** Captures the form posted to the token endpoint and answers with `reply`. */
function tokenEndpoint(reply: () => Response) {
  const forms: Record<string, string>[] = [];
  upstream.use(
    http.post(TOKEN_URL, async ({ request }) => {
      expect(request.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
      forms.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return reply();
    }),
  );
  return forms;
}

const grantBody = (over: Record<string, unknown> = {}) => ({
  access_token: ACCESS,
  token_type: 'bearer',
  expires_in: 3599,
  scope: 'openid organized_play offline',
  refresh_token: 'ory_rt_next',
  id_token: 'id.token.here',
  ...over,
});

async function upstreamError(promise: Promise<unknown>): Promise<PokemonUpstreamError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PokemonUpstreamError);
  return err as PokemonUpstreamError;
}

describe('authorizeUrl', () => {
  it("points at Pokémon's own login with the play-tools client parameters", () => {
    const url = new URL(client().authorizeUrl('chal', 'st'));
    expect(url.origin + url.pathname).toBe('https://access.pokemon.com/oauth2/auth');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('client_id')).toBe('op-tools-app');
  });

  it('honours a base URL override (test doubles only)', () => {
    const url = createPtcOAuthClient({ baseUrl: 'http://127.0.0.1:9/' }).authorizeUrl('c', 's');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:9\/oauth2\/auth\?/);
  });
});

describe('exchangeCode', () => {
  it('redeems the code with the PKCE verifier as a public client', async () => {
    const forms = tokenEndpoint(() => HttpResponse.json(grantBody()));

    const grant = await client().exchangeCode('the-code', 'the-verifier');

    expect(forms).toEqual([
      {
        grant_type: 'authorization_code',
        client_id: 'op-tools-app',
        code: 'the-code',
        code_verifier: 'the-verifier',
        redirect_uri: 'https://play-tools.pokemon.com/loggedIn',
      },
    ]);
    expect(grant).toEqual({
      accessToken: ACCESS,
      expiresAt: new Date(NOW.getTime() + 3599_000),
      subject: SUB,
      refreshToken: 'ory_rt_next',
    });
  });

  it('maps invalid_grant (code already used or expired) to needs_reconnect', async () => {
    tokenEndpoint(() =>
      HttpResponse.json({ error: 'invalid_grant', error_description: 'The authorization code has already been used.' }, { status: 400 }),
    );
    const err = await upstreamError(client().exchangeCode('used', 'v'));
    expect(err.code).toBe('needs_reconnect');
    expect(err.message).toMatch(/already been used/);
  });
});

describe('refresh', () => {
  it('sends the refresh grant with no client secret and returns the rotated token', async () => {
    const forms = tokenEndpoint(() => HttpResponse.json(grantBody({ refresh_token: 'ory_rt_rotated' })));

    const grant = await client().refresh('ory_rt_current');

    expect(forms).toEqual([{ grant_type: 'refresh_token', client_id: 'op-tools-app', refresh_token: 'ory_rt_current' }]);
    expect(grant.refreshToken).toBe('ory_rt_rotated');
    expect(grant.subject).toBe(SUB);
  });

  it('reports a missing refresh_token as null rather than inventing one', async () => {
    tokenEndpoint(() => HttpResponse.json(grantBody({ refresh_token: undefined })));
    expect((await client().refresh('ory_rt_current')).refreshToken).toBeNull();
  });

  it('maps invalid_grant (revoked or reused chain) to needs_reconnect', async () => {
    tokenEndpoint(() => HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }));
    expect((await upstreamError(client().refresh('ory_rt_dead'))).code).toBe('needs_reconnect');
  });

  it.each([
    [429, 'rate_limited', true],
    [500, 'unavailable', true],
    [503, 'unavailable', true],
  ] as const)('maps HTTP %i to %s (retryable: %s)', async (status, code, retryable) => {
    tokenEndpoint(() => new HttpResponse('<html>busy</html>', { status, headers: { 'content-type': 'text/html' } }));
    const err = await upstreamError(client().refresh('ory_rt'));
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.details.status).toBe(status);
  });

  it('reads Retry-After on 429', async () => {
    tokenEndpoint(() => new HttpResponse(null, { status: 429, headers: { 'retry-after': '30' } }));
    expect((await upstreamError(client().refresh('ory_rt'))).details.retryAfterMs).toBe(30_000);
  });

  it('maps another OAuth error (e.g. the client was changed) to forbidden, naming the error', async () => {
    tokenEndpoint(() => HttpResponse.json({ error: 'invalid_client' }, { status: 401 }));
    const err = await upstreamError(client().refresh('ory_rt'));
    expect(err.code).toBe('forbidden');
    expect(err.message).toMatch(/invalid_client/);
  });

  it('maps a network failure to unavailable', async () => {
    upstream.use(http.post(TOKEN_URL, () => HttpResponse.error()));
    expect((await upstreamError(client().refresh('ory_rt'))).code).toBe('unavailable');
  });

  it.each([
    ['no access_token', grantBody({ access_token: undefined })],
    ['an opaque access token', grantBody({ access_token: 'ory_at_opaque' })],
    ['a JWT without sub', grantBody({ access_token: fakeAccessToken({ sub: '', exp: 1 }) })],
  ])('fails loudly on %s, without putting tokens in the error', async (_label, body) => {
    tokenEndpoint(() => HttpResponse.json(body));
    const err = await upstreamError(client().refresh('ory_rt_secret'));
    expect(err.code).toBe('unexpected_shape');
    expect(err.message).not.toMatch(/ory_rt|ory_at/);
    expect(JSON.stringify(err.details)).not.toMatch(/ory_rt/);
  });
});

describe('revoke', () => {
  it('revokes the refresh token at Hydra', async () => {
    const forms: Record<string, string>[] = [];
    upstream.use(
      http.post('https://access.pokemon.com/oauth2/revoke', async ({ request }) => {
        forms.push(Object.fromEntries(new URLSearchParams(await request.text())));
        return new HttpResponse(null, { status: 200 });
      }),
    );

    await client().revoke('ory_rt_bye');

    expect(forms).toEqual([{ token: 'ory_rt_bye', token_type_hint: 'refresh_token', client_id: 'op-tools-app' }]);
  });

  it('maps a failure like any other call', async () => {
    upstream.use(http.post('https://access.pokemon.com/oauth2/revoke', () => new HttpResponse(null, { status: 502 })));
    expect((await upstreamError(client().revoke('ory_rt'))).code).toBe('unavailable');
  });
});
