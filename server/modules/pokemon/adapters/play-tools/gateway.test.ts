import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlayerId } from '../../../../../shared/types/ids';
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

  it('fails loudly on an unexpected shape, logging only its outline, never the values (player names)', async () => {
    log.warn.mockClear();
    upstream.use(http.get(GROUPS_URL, () => HttpResponse.json({ data: [{ display_first_name: 'Ash' }], extra: 1 })));
    expect((await upstreamError(gateway().listLeagues())).code).toBe('unexpected_shape');

    expect(log.warn).toHaveBeenCalledOnce();
    const [message, fields] = log.warn.mock.calls[0]!;
    expect(message).toMatch(/did not match the wire contract/);
    expect(message).not.toMatch(/^\[pokemon\]/);
    expect(fields).toEqual({
      what: expect.any(String),
      path: expect.stringMatching(/activity_groups\/$/),
      keys: ['data', 'extra'],
      issues: expect.arrayContaining([{ path: expect.any(Array), code: expect.any(String) }]),
    });
    for (const issue of fields.issues) expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('Ash');
  });

  it('names the JSON type of a body that is not an object, and "string" for one that is not JSON at all', async () => {
    log.warn.mockClear();
    upstream.use(http.get(GROUPS_URL, () => HttpResponse.json(['Ash'])));
    await upstreamError(gateway().listLeagues());
    upstream.use(http.get(GROUPS_URL, () => new HttpResponse('<h1>Ash</h1>', { headers: { 'content-type': 'text/html' } })));
    await upstreamError(gateway().listLeagues());

    expect(log.warn.mock.calls.map(([, fields]) => fields.keys)).toEqual(['array', 'string']);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('Ash');
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

const GROUP = 'group-1';
const SESSIONS_URL = `https://api.play.pokemon.com/services/core/activity_groups/${GROUP}/play_sessions/`;
const session = (guid: string, start: string, over: Record<string, unknown> = {}) => ({
  guid,
  type: 'open_play',
  status: 'pending',
  start_date: start,
  end_date: null,
  final_modifiable_datetime: null,
  products: ['tcg'],
  attributes: [],
  schedule: null,
  ...over,
});
// Tuesday 2026-10-13, 00:00 to 24:00 Central (UTC-5).
const TUESDAY = { from: new Date('2026-10-13T05:00:00Z'), to: new Date('2026-10-14T05:00:00Z') };

describe('listPlaySessions (S3: activity_groups/{id}/play_sessions/)', () => {
  it('asks for one status at a time with the start-date filters as UTC instants', async () => {
    const seen: URLSearchParams[] = [];
    upstream.use(
      http.get(SESSIONS_URL, ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json(page([]));
      }),
    );

    expect(await gateway().listPlaySessions(GROUP, TUESDAY)).toEqual([]);
    expect(seen.map((q) => q.get('status'))).toEqual(['active', 'complete', 'pending']);
    expect(seen[0]!.get('start_date:greater_than_or_equal_to')).toBe('2026-10-13T05:00:00.000Z');
    expect(seen[0]!.get('start_date:less_than_or_equal_to')).toBe('2026-10-14T05:00:00.000Z');
  });

  it('stops at the first status with a match and maps the recorded session shape', async () => {
    const recorded = fixture('play-sessions-page.complete.last30d') as { results: Record<string, unknown>[] };
    const first = recorded.results[0]!;
    const statuses: string[] = [];
    upstream.use(
      http.get(SESSIONS_URL, ({ request }) => {
        const status = new URL(request.url).searchParams.get('status')!;
        statuses.push(status);
        return HttpResponse.json(status === 'complete' ? page([first]) : page([]));
      }),
    );

    const sessions = await gateway().listPlaySessions(GROUP, { from: new Date('2026-09-13T05:00:00Z'), to: new Date('2026-09-14T05:00:00Z') });

    expect(statuses).toEqual(['active', 'complete']);
    expect(sessions).toEqual([
      {
        id: first.guid,
        type: 'open_play',
        products: ['pgo', 'tcg', 'vg'],
        status: 'complete',
        startsAt: new Date('2026-09-13T17:00:00Z'),
        endsAt: new Date('2026-09-13T21:00:00Z'),
        editableUntil: new Date('2026-09-20T17:00:00Z'),
      },
    ]);
  });

  it('leaves out a session starting exactly at the end of the range (the upstream filter is inclusive)', async () => {
    upstream.use(
      http.get(SESSIONS_URL, () =>
        HttpResponse.json(page([session('in', '2026-10-13T23:00:00Z'), session('next-day', '2026-10-14T05:00:00Z')])),
      ),
    );
    expect((await gateway().listPlaySessions(GROUP, TUESDAY, ['pending'])).map((s) => s.id)).toEqual(['in']);
  });

  it('queries only the statuses asked for, in that order', async () => {
    const statuses: string[] = [];
    upstream.use(
      http.get(SESSIONS_URL, ({ request }) => {
        statuses.push(new URL(request.url).searchParams.get('status')!);
        return HttpResponse.json(page([]));
      }),
    );
    await gateway().listPlaySessions(GROUP, TUESDAY, ['pending', 'active']);
    expect(statuses).toEqual(['pending', 'active']);
  });

  it('follows next pages', async () => {
    upstream.use(
      http.get(SESSIONS_URL, ({ request }) =>
        new URL(request.url).searchParams.get('page') === '2'
          ? HttpResponse.json(page([session('b', '2026-10-13T23:30:00Z')]))
          : HttpResponse.json(page([session('a', '2026-10-13T17:00:00Z')], `${SESSIONS_URL}?status=pending&page=2`)),
      ),
    );
    expect((await gateway().listPlaySessions(GROUP, TUESDAY, ['pending'])).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('fails loudly on an unknown status value', async () => {
    upstream.use(http.get(SESSIONS_URL, () => HttpResponse.json(page([session('a', '2026-10-13T17:00:00Z', { status: 'scheduled' })]))));
    expect((await upstreamError(gateway().listPlaySessions(GROUP, TUESDAY))).code).toBe('unexpected_shape');
  });
});

const SESSION = 'session-1';
const RECORDS_URL = `${SESSIONS_URL}${SESSION}/records/`;
const BULK_URL = `${RECORDS_URL}_bulk/`;

describe('listAttendance (S3/S4: play_sessions/{id}/records/)', () => {
  it('lists every record, staff included, from the recorded response (design change 6)', async () => {
    let query: URLSearchParams | undefined;
    upstream.use(
      http.get(RECORDS_URL, ({ request }) => {
        query = new URL(request.url).searchParams;
        return HttpResponse.json(fixture('attendance-page.s4.after-batch.p1'));
      }),
    );

    const records = await gateway().listAttendance(GROUP, SESSION);

    expect(query!.has('player')).toBe(false);
    expect(records.map((r) => [r.playerId, r.isPlayer])).toEqual([
      ['9999912', true],
      ['9999913', true],
      ['9999991', false],
    ]);
    expect(records[0]).toEqual({ recordId: expect.any(String), playerId: '9999912', isPlayer: true, name: '<redacted> <redacted>' });
  });

  it('follows pages and keeps leading zeros; a missing name is empty', async () => {
    const rec = (guid: string, playerId: string | number) => ({
      guid,
      role: null,
      player: true,
      origin: 'roster',
      updated: '',
      participant: { guid: `p-${guid}`, player_id: playerId, display_first_name: null, display_last_name: null },
    });
    upstream.use(
      http.get(RECORDS_URL, ({ request }) =>
        new URL(request.url).searchParams.get('page') === '2'
          ? HttpResponse.json(page([rec('r2', 42)]))
          : HttpResponse.json(page([rec('r1', '0012345')], `${RECORDS_URL}?page=2`)),
      ),
    );
    expect(await gateway().listAttendance(GROUP, SESSION)).toEqual([
      { recordId: 'r1', playerId: '0012345', isPlayer: true, name: '' },
      { recordId: 'r2', playerId: '42', isPlayer: true, name: '' },
    ]);
  });

  it('is not_found for a session play-tools does not know', async () => {
    upstream.use(http.get(RECORDS_URL, () => HttpResponse.json({ code: 'op.generic.not_found' }, { status: 404 })));
    expect((await upstreamError(gateway().listAttendance(GROUP, SESSION))).code).toBe('not_found');
  });
});

describe('addAttendanceBulk (S4: records/_bulk/)', () => {
  const recorded = (name: string) => {
    const raw = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', `${name}.json`), 'utf8')) as { status: number; body: unknown };
    return typeof raw.body === 'string'
      ? new HttpResponse(raw.body, { status: raw.status, headers: { 'content-type': 'text/html' } })
      : HttpResponse.json(raw.body as object, { status: raw.status });
  };
  const ids = (...xs: string[]) => xs as unknown as PlayerId[];

  it('sends exactly the CLI payload and maps each record guid to its player, in request order', async () => {
    let body: unknown;
    upstream.use(
      http.post(BULK_URL, async ({ request }) => {
        body = await request.json();
        return recorded('bulk-response.batch');
      }),
    );

    const result = await gateway().addAttendanceBulk(GROUP, SESSION, ids('0012345', '678'));

    expect(body).toEqual([
      { participant: { player_id: '0012345' }, role: null, player: true, origin: 'roster', updated: '' },
      { participant: { player_id: '678' }, role: null, player: true, origin: 'roster', updated: '' },
    ]);
    expect(result).toEqual({
      status: 'added',
      records: [
        { playerId: '0012345', recordId: '00000000-0000-4000-8000-000000000036' },
        { playerId: '678', recordId: '00000000-0000-4000-8000-000000000039' },
      ],
    });
  });

  it('maps a recorded duplicate rejection back to the player at that index; nobody was added', async () => {
    upstream.use(http.post(BULK_URL, () => recorded('bulk-response.duplicate')));
    expect(await gateway().addAttendanceBulk(GROUP, SESSION, ids('1', '2', '3'))).toEqual({
      status: 'rejected',
      alreadyPresent: ['1'],
      failed: [],
    });
  });

  it('reports any other per-player rejection as failed with its code', async () => {
    upstream.use(
      http.post(BULK_URL, () =>
        HttpResponse.json(
          {
            code: 'op.generic.bad_request',
            errors: {
              body: {
                '0.participant.player_id': [{ code: 'op.activity_record.cannot_duplicate_participant' }],
                '2.participant.player_id': [{ code: 'op.player.not_found', message: 'No such player.' }],
              },
            },
          },
          { status: 400 },
        ),
      ),
    );
    expect(await gateway().addAttendanceBulk(GROUP, SESSION, ids('1', '2', '3'))).toEqual({
      status: 'rejected',
      alreadyPresent: ['1'],
      failed: [{ playerId: '3', error: 'op.player.not_found' }],
    });
  });

  it('fails every player when a 400 names nobody in particular', async () => {
    upstream.use(http.post(BULK_URL, () => HttpResponse.json({ code: 'op.generic.bad_request', message: 'Invalid request.' }, { status: 400 })));
    expect(await gateway().addAttendanceBulk(GROUP, SESSION, ids('1', '2'))).toEqual({
      status: 'rejected',
      alreadyPresent: [],
      failed: [
        { playerId: '1', error: 'op.generic.bad_request' },
        { playerId: '2', error: 'op.generic.bad_request' },
      ],
    });
  });

  it('turns the recorded HTML 500 into a retryable unavailable', async () => {
    upstream.use(http.post(BULK_URL, () => recorded('bulk-response.mixed')));
    const err = await upstreamError(gateway().addAttendanceBulk(GROUP, SESSION, ids('1')));
    expect(err.code).toBe('unavailable');
    expect(err.retryable).toBe(true);
  });

  it('fails loudly when the 201 body does not have one record per player', async () => {
    log.warn.mockClear();
    upstream.use(http.post(BULK_URL, () => HttpResponse.json([{ guid: 'only-one' }], { status: 201 })));
    expect((await upstreamError(gateway().addAttendanceBulk(GROUP, SESSION, ids('1', '2')))).code).toBe('unexpected_shape');
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ keys: 'array', issues: [] }));
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('only-one');
  });

  it('refuses a malformed player id before calling play-tools (one bad id fails the whole batch upstream)', async () => {
    await expect(gateway().addAttendanceBulk(GROUP, SESSION, ids('1', 'not-a-player-id'))).rejects.toThrow(TypeError);
  });

  it('calls nothing for an empty batch', async () => {
    expect(await gateway().addAttendanceBulk(GROUP, SESSION, [])).toEqual({ status: 'added', records: [] });
  });
});
