import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PokemonUpstreamError } from '../../ports/errors';
import type { TokenProvider } from '../../ports/token-provider';
import { createPlayToolsHttpAdapter } from './gateway';

const SUB = '0123456789abcdef0123456789abcdef';
const GROUPS_URL = `https://api.play.pokemon.com/services/core/users/${SUB}/activity_groups/`;
const fixture = (name: string) =>
  (JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', `${name}.json`), 'utf8')) as { body: Record<string, unknown> }).body;
const RECORDED = fixture('activity-groups-page.access_token.sub');

const upstream = setupServer();
beforeAll(() => upstream.listen({ onUnhandledRequest: 'error' }));
afterEach(() => upstream.resetHandlers());
afterAll(() => upstream.close());

const tokens: TokenProvider = {
  getAccessToken: vi.fn(async () => ({ value: 'access-jwt', expiresAt: new Date(Date.now() + 3_600_000), subject: SUB })),
};
const log = { warn: vi.fn() };
const gateway = () => createPlayToolsHttpAdapter({ tokens, leagueId: 'default', log });

async function upstreamError(promise: Promise<unknown>): Promise<PokemonUpstreamError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PokemonUpstreamError);
  return err as PokemonUpstreamError;
}

const group = (guid: string, over: Record<string, unknown> = {}) => ({
  guid,
  display_id: `L${guid}`,
  group_type: 'league',
  name: null,
  display_name: `Store ${guid}`,
  criteria: { play_sessions: { create_attendance: true } },
  ...over,
});
const page = (results: unknown[], next: string | null = null) => ({ count: results.length, next, previous: null, results });

describe('listLeagues (S5: core/users/{sub}/activity_groups/)', () => {
  it("lists the organizer's leagues from the recorded response, leaving out the personal group", async () => {
    let seen: Request | undefined;
    upstream.use(
      http.get(GROUPS_URL, ({ request }) => {
        seen = request;
        return HttpResponse.json(RECORDED);
      }),
    );

    expect(await gateway().listLeagues()).toEqual([
      { id: '00000000-0000-4000-8000-000000000004', name: '<redacted>', displayId: 'L5012', canSubmit: true },
    ]);
    expect(tokens.getAccessToken).toHaveBeenCalledWith('default');
    expect(seen!.headers.get('authorization')).toBe('Bearer access-jwt');
    expect(seen!.headers.get('origin')).toBe('https://play-tools.pokemon.com');
  });

  it('follows next pages to the end', async () => {
    upstream.use(
      http.get(GROUPS_URL, ({ request }) =>
        new URL(request.url).searchParams.get('page') === '2'
          ? HttpResponse.json(page([group('2')]))
          : HttpResponse.json(page([group('1')], `${GROUPS_URL}?page=2`)),
      ),
    );
    expect((await gateway().listLeagues()).map((l) => l.id)).toEqual(['1', '2']);
  });

  it('refuses to follow a next link to another host', async () => {
    upstream.use(http.get(GROUPS_URL, () => HttpResponse.json(page([group('1')], 'https://evil.example/steal'))));
    expect((await upstreamError(gateway().listLeagues())).code).toBe('unexpected_shape');
  });

  it('reports canSubmit false when the organizer lacks create_attendance, and names a league with no store name by its id', async () => {
    upstream.use(
      http.get(GROUPS_URL, () =>
        HttpResponse.json(page([group('1', { display_name: null, criteria: { play_sessions: { create_attendance: false } } })])),
      ),
    );
    expect(await gateway().listLeagues()).toEqual([{ id: '1', name: 'L1', displayId: 'L1', canSubmit: false }]);
  });

  it.each([
    [401, 'forbidden'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [502, 'unavailable'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    upstream.use(http.get(GROUPS_URL, () => HttpResponse.json({ code: 'op.generic.x', message: 'nope' }, { status })));
    expect((await upstreamError(gateway().listLeagues())).code).toBe(code);
  });

  it('fails loudly on an unexpected shape and logs the raw body', async () => {
    upstream.use(http.get(GROUPS_URL, () => HttpResponse.json({ data: [] })));
    expect((await upstreamError(gateway().listLeagues())).code).toBe('unexpected_shape');
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/activity_groups/), { body: { data: [] } });
  });

  it('passes a token-provider failure (e.g. needs_reconnect) through without calling play-tools', async () => {
    const dead: TokenProvider = {
      getAccessToken: async () => {
        throw new PokemonUpstreamError('needs_reconnect', 'reconnect');
      },
    };
    const err = await upstreamError(createPlayToolsHttpAdapter({ tokens: dead, leagueId: 'default' }).listLeagues());
    expect(err.code).toBe('needs_reconnect');
  });

  it('honours a base URL override (test doubles only)', async () => {
    upstream.use(http.get(`http://127.0.0.1:9/services/core/users/${SUB}/activity_groups/`, () => HttpResponse.json(page([]))));
    expect(await createPlayToolsHttpAdapter({ tokens, leagueId: 'default', baseUrl: 'http://127.0.0.1:9/services/' }).listLeagues()).toEqual([]);
  });
});
