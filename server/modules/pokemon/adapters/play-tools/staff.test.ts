import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerId } from '../../../../../shared/types/ids';
import { PokemonUpstreamError } from '../../ports/errors';
import type { TokenProvider } from '../../ports/token-provider';
import { createPlayToolsHttpAdapter } from './gateway';

/**
 * Tournaments and staff (ADR-0007, architecture §4.3), pinned to the S6
 * recordings in `__fixtures__/s6/` (`{ method, path, query, status, request, response }`).
 */
const S6 = join(import.meta.dirname, '__fixtures__', 's6');
interface Recording {
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  request: unknown;
  response: Record<string, unknown> & { results?: Record<string, unknown>[] };
}
const recording = (n: string): Recording => {
  const file = readdirSync(S6).find((f) => f.startsWith(`${n}.`));
  if (!file) throw new Error(`no S6 fixture ${n}`);
  return JSON.parse(readFileSync(join(S6, file), 'utf8')) as Recording;
};

const API = 'https://api.play.pokemon.com/services/';
const T = '00000000-0000-4000-8000-000000000001';
const ACTIVITIES_URL = `${API}core/activities`;
const DETAILS_URL = `${API}core/tournament/:t`;
const RECORDS_URL = `${API}core/tournaments/:t/records`;
const RECORD_URL = `${API}core/tournaments/:t/records/:r`;

const upstream = setupServer();
const seen: Request[] = [];
beforeAll(() => upstream.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  seen.length = 0;
  upstream.events.on('request:start', ({ request }) => void seen.push(request.clone()));
});
afterEach(() => {
  upstream.resetHandlers();
  upstream.events.removeAllListeners();
});
afterAll(() => upstream.close());

const getAccessToken = vi.fn(async () => ({ value: 'access-jwt', expiresAt: new Date(Date.now() + 3_600_000), subject: 'sub' }));
const tokens: TokenProvider = { getAccessToken };
const log = { warn: vi.fn() };
beforeEach(() => {
  getAccessToken.mockClear();
  log.warn.mockClear();
});
const gateway = () => createPlayToolsHttpAdapter({ tokens, connectionId: 1, log });
const pid = (s: string) => s as PlayerId;

async function upstreamError(promise: Promise<unknown>): Promise<PokemonUpstreamError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PokemonUpstreamError);
  return err as PokemonUpstreamError;
}

describe('listStaffRoles', () => {
  it('offers the five play-tools roles in the UI order, judge first, never organizer', () => {
    const roles = gateway().listStaffRoles();
    expect(roles).toEqual([
      { code: 'judge', label: 'Judge' },
      { code: 'headjudge', label: 'Head Judge' },
      { code: 'scorekeeper', label: 'Scorekeeper' },
      { code: 'administration', label: 'Support Staff' },
      { code: 'translator', label: 'Translator' },
    ]);
    expect(roles.map((r) => r.code)).not.toContain('organizer');
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });
});

describe('tournament_locked', () => {
  it('is not retryable: a tournament past its window stays locked', () => {
    expect(new PokemonUpstreamError('tournament_locked', 'locked').retryable).toBe(false);
  });
});

const LEAGUE = '00000000-0000-4000-8000-000000000003';
let rowSerial = 0;
const row = (startV2: string | null, over: Record<string, unknown> = {}) => ({
  guid: `t-${++rowSerial}`,
  activity_type: 'tournament',
  name: 'League Challenge',
  display_id: `26-10-9${String(rowSerial).padStart(5, '0')}`,
  product: 'tcg',
  // Wall-clock time stamped Z (S6): never to be read.
  start_date: startV2 ? new Date(Date.parse(startV2) - 5 * 3_600_000).toISOString().replace('.000', '') : '2024-10-26T16:00:00Z',
  start_date_v2: startV2,
  address: 'somewhere',
  activity_group: { guid: LEAGUE, group_type: 'league', name: null, owner: { guid: 'o', player_id: '9999992' } },
  activity_state: 'pending',
  application_state: 'sanctioned',
  status: 'sanctioned',
  ...over,
});
const page = (results: unknown[], next: string | null = null) => ({ count: results.length, next, previous: null, results });
const day = (iso: string) => ({ from: new Date(`${iso}T00:00:00Z`), to: new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000) });
const DAY_MS = 86_400_000;

describe('listTournaments (S6: core/activities, organizer only)', () => {
  it('maps the recorded page by start_date_v2, never the wall-clock start_date', async () => {
    const recorded = recording('19');
    upstream.use(http.get(ACTIVITIES_URL, () => HttpResponse.json(recorded.response)));

    const found = await gateway().listTournaments(day('2026-10-25'));

    expect(found).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000081',
        name: '<redacted>',
        displayId: '26-10-900053',
        groupId: LEAGUE,
        products: ['tcg'],
        startsAt: new Date('2026-10-25T17:30:00Z'),
        status: 'sanctioned',
        applicationState: 'sanctioned',
        editableUntil: new Date(Date.parse('2026-10-25T17:30:00Z') + 90 * DAY_MS),
      },
      {
        id: '00000000-0000-4000-8000-000000000080',
        name: '<redacted>',
        displayId: '26-10-900052',
        groupId: LEAGUE,
        products: ['tcg'],
        startsAt: new Date('2026-10-25T21:30:00Z'),
        status: 'sanctioned',
        applicationState: 'sanctioned',
        editableUntil: new Date(Date.parse('2026-10-25T21:30:00Z') + 90 * DAY_MS),
      },
    ]);
    // The recorded page reaches back to May, so there is no need for page 2.
    expect(seen).toHaveLength(1);
  });

  it('asks for the organizer\'s tournaments newest first, in every activity group, with a fresh token', async () => {
    upstream.use(http.get(ACTIVITIES_URL, () => HttpResponse.json(page([]))));

    await gateway().listTournaments(day('2026-10-25'));

    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe('/services/core/activities');
    expect(Object.fromEntries(url.searchParams)).toEqual({ type: 'tournament', role: 'organizer', sort_by: '-start_date', page_size: '40' });
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer access-jwt');
    expect(seen[0]!.headers.get('origin')).toBe('https://play-tools.pokemon.com');
    expect(getAccessToken).toHaveBeenCalledWith(1);
  });

  it('stops paging once a page reaches back past the range (at most 2 of 3 pages for a current date)', async () => {
    // 117 tournaments newest first, 40/40/37, one a day back from 2026-12-31.
    const all = Array.from({ length: 117 }, (_, i) => row(new Date(Date.parse('2026-12-31T18:00:00Z') - i * DAY_MS).toISOString()));
    const pages = [all.slice(0, 40), all.slice(40, 80), all.slice(80)];
    upstream.use(
      http.get(ACTIVITIES_URL, ({ request }) => {
        const n = Number(new URL(request.url).searchParams.get('page') ?? '1');
        return HttpResponse.json(page(pages[n - 1]!, n < 3 ? `${ACTIVITIES_URL}?page=${n + 1}&page_size=40` : null));
      }),
    );

    // 2026-11-25 is the 37th row: page 1 ends on 11-22, already a day past it.
    const onPage1 = await gateway().listTournaments(day('2026-11-25'));
    expect(onPage1.map((t) => t.startsAt)).toEqual([new Date('2026-11-25T18:00:00Z')]);
    expect(seen).toHaveLength(1);

    seen.length = 0;
    // 2026-11-21 is row 41, the first on page 2.
    const onPage2 = await gateway().listTournaments(day('2026-11-21'));
    expect(onPage2.map((t) => t.startsAt)).toEqual([new Date('2026-11-21T18:00:00Z')]);
    expect(seen).toHaveLength(2);
  });

  it('reads one more page when the last row is within 24 h before the range (start_date ordering is wall-clock)', async () => {
    const p1 = [row('2026-10-26T18:00:00Z'), row('2026-10-24T23:30:00Z')];
    const p2 = [row('2026-10-25T03:00:00Z'), row('2026-10-20T18:00:00Z')];
    upstream.use(
      http.get(ACTIVITIES_URL, ({ request }) =>
        new URL(request.url).searchParams.get('page') === '2'
          ? HttpResponse.json(page(p2, `${ACTIVITIES_URL}?page=3`))
          : HttpResponse.json(page(p1, `${ACTIVITIES_URL}?page=2`)),
      ),
    );

    const found = await gateway().listTournaments(day('2026-10-25'));

    expect(found.map((t) => t.startsAt)).toEqual([new Date('2026-10-25T03:00:00Z')]);
    expect(seen).toHaveLength(2);
  });

  it('keeps live tournaments of every activity group and drops cancelled, deleted, invalidated and non-tournament rows', async () => {
    const other = { guid: 'other-store', group_type: 'league', name: null, owner: null };
    const rows = [
      row(null, { status: 'cancelled' }),
      row(null, { status: 'deleted' }),
      row(null, { status: 'invalidated' }),
      row(null, { status: 'sanctioned', guid: 'keep-sanctioned' }),
      row(null, { status: 'complete', guid: 'keep-complete' }),
      row(null, { status: 'approval-pending', guid: 'keep-pending' }),
      row(null, { status: 'on-hold', guid: 'keep-unknown-status' }),
      row(null, { status: 'sanctioned', guid: 'keep-other-store', activity_group: other }),
      row(null, { status: 'complete', guid: 'keep-no-group', activity_group: null }),
      row(null, { activity_type: 'play_session', guid: 'drop-session' }),
    ];
    upstream.use(http.get(ACTIVITIES_URL, () => HttpResponse.json(page(rows))));

    const found = await gateway().listTournaments();

    expect(found.map((t) => [t.id, t.groupId, t.status])).toEqual([
      ['keep-complete', LEAGUE, 'complete'],
      ['keep-no-group', null, 'complete'],
      ['keep-other-store', 'other-store', 'sanctioned'],
      ['keep-pending', LEAGUE, 'approval-pending'],
      ['keep-sanctioned', LEAGUE, 'sanctioned'],
      ['keep-unknown-status', LEAGUE, 'on-hold'],
    ]);
  });

  it('carries the application state, which stays sanctioned once a tournament is complete, and null when absent', async () => {
    const { application_state: _dropped, ...bare } = row('2026-10-25T17:00:00Z', { guid: 'bare' });
    const rows = [row('2026-10-25T16:00:00Z', { guid: 'held', status: 'complete', application_state: 'sanctioned' }), bare];
    upstream.use(http.get(ACTIVITIES_URL, () => HttpResponse.json(page(rows))));

    const found = await gateway().listTournaments(day('2026-10-25'));

    expect(found.map((t) => [t.id, t.status, t.applicationState])).toEqual([
      ['held', 'complete', 'sanctioned'],
      ['bare', 'sanctioned', null],
    ]);
  });

  it('returns undated tournaments only when listing without a range (fixture 04: start_date_v2 is null)', async () => {
    const recorded = recording('04');
    upstream.use(http.get(ACTIVITIES_URL, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.get('page') ? page([]) : recorded.response)));
    const live = recorded.response.results!.filter((r) => !['cancelled', 'deleted', 'invalidated'].includes(r.status as string));

    const everything = await gateway().listTournaments();
    expect(everything).toHaveLength(live.length);
    expect(everything.every((t) => t.startsAt === null && t.editableUntil === null)).toBe(true);
    const groups = new Set(live.map((r) => (r.activity_group as { guid: string }).guid));
    expect(groups.size).toBeGreaterThan(1);
    expect(new Set(everything.map((t) => t.groupId))).toEqual(groups);

    expect(await gateway().listTournaments(day('2024-10-26'))).toEqual([]);
  });

  it('pages to the end when every row is undated, since nothing shows the range has been passed', async () => {
    upstream.use(
      http.get(ACTIVITIES_URL, ({ request }) =>
        new URL(request.url).searchParams.get('page') === '2'
          ? HttpResponse.json(page([row(null)]))
          : HttpResponse.json(page([row(null)], `${ACTIVITIES_URL}?page=2`)),
      ),
    );

    expect(await gateway().listTournaments(day('2026-10-25'))).toEqual([]);
    expect(seen).toHaveLength(2);
  });

  it('orders the result by start, undated first, then by id', async () => {
    upstream.use(
      http.get(ACTIVITIES_URL, () =>
        HttpResponse.json(page([row('2026-10-25T20:00:00Z', { guid: 'b' }), row(null, { guid: 'z' }), row('2026-10-25T20:00:00Z', { guid: 'a' }), row('2026-10-25T09:00:00Z', { guid: 'c' }), row(null, { guid: 'y' })])),
      ),
    );

    expect((await gateway().listTournaments()).map((t) => t.id)).toEqual(['y', 'z', 'c', 'a', 'b']);
  });

  it('refuses a next page on another host', async () => {
    upstream.use(http.get(ACTIVITIES_URL, () => HttpResponse.json(page([row(null)], 'https://evil.example/services/core/activities?page=2'))));

    expect((await upstreamError(gateway().listTournaments())).code).toBe('unexpected_shape');
    expect(seen).toHaveLength(1);
  });

  it('fails loudly on an unexpected page shape, logging its outline without values', async () => {
    upstream.use(http.get(ACTIVITIES_URL, () => HttpResponse.json({ count: 1, next: null, previous: null, results: [{ guid: 'Ash Ketchum' }] })));

    expect((await upstreamError(gateway().listTournaments())).code).toBe('unexpected_shape');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls[0])).not.toContain('Ash Ketchum');
  });
});

/** Every key anywhere in a value: no upstream-only field may cross the port. */
function keysDeep(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, into));
  else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysDeep(v, into);
    }
  }
  return into;
}
const UPSTREAM_ONLY = ['year_of_birth', 'user', 'address', 'first_name', 'last_name', 'organizer', 'participant', 'guid', 'start_date', 'start_date_v2'];

describe('getTournament (S6: core/tournament/{t}, singular)', () => {
  it('returns the recorded tournament with its organizer, dated by true UTC', async () => {
    const recorded = recording('01');
    upstream.use(http.get(DETAILS_URL, () => HttpResponse.json(recorded.response)));

    const details = await gateway().getTournament(T);

    expect(new URL(seen[0]!.url).pathname).toBe(`/services/core/tournament/${T}`);
    expect(details).toEqual({
      id: T,
      name: '<redacted>',
      displayId: '26-10-900001',
      groupId: expect.any(String),
      products: ['pgo'],
      startsAt: new Date('2026-10-11T19:30:00Z'),
      status: 'complete',
      editableUntil: new Date(Date.parse('2026-10-11T19:30:00Z') + 90 * DAY_MS),
      organizerPlayerId: '9999991',
      organizerName: '<redacted> <redacted>',
      applicationState: 'sanctioned',
      activityState: 'completed',
      category: 'pgo_std',
      series: { id: '5b099da4be26f5d468491dc83244370e', name: '<redacted>' },
      venue: null,
      contact: { email: '<redacted>', phone: '<redacted>' },
      registration: { startsAt: new Date('2026-10-11T19:00:00Z'), endsAt: new Date('2026-10-11T19:30:00Z') },
      onSiteAdmission: 'FREE',
      thirdPartyRegistrationUrl: null,
      details: '<redacted>',
      eventWebsite: '<redacted>',
    });
    expect([...keysDeep(details)].filter((k) => UPSTREAM_ONLY.includes(k))).toEqual([]);
  });

  it('falls back to start_date_actual when start_date_v2 is missing, and never to start_date', async () => {
    const recorded = recording('01');
    upstream.use(http.get(DETAILS_URL, () => HttpResponse.json({ ...recorded.response, start_date_v2: null })));
    expect((await gateway().getTournament(T)).startsAt).toEqual(new Date('2026-10-11T19:30:00Z'));

    upstream.use(http.get(DETAILS_URL, () => HttpResponse.json({ ...recorded.response, start_date_v2: null, start_date_actual: null })));
    const undated = await gateway().getTournament(T);
    expect(undated.startsAt).toBeNull();
    expect(undated.editableUntil).toBeNull();
  });

  it('throws not_found for a tournament play-tools does not have', async () => {
    upstream.use(http.get(DETAILS_URL, () => HttpResponse.json({ code: 'op.generic.not_found' }, { status: 404 })));
    expect((await upstreamError(gateway().getTournament(T))).code).toBe('not_found');
  });
});

describe('listTournamentParticipants (S6: core/tournaments/{t}/records, unfiltered)', () => {
  const page2 = (recorded: Recording) => ({
    ...recorded.response,
    next: null,
    previous: `${API}core/tournaments/${T}/records?page=1&page_size=5`,
    results: [
      { ...recorded.response.results![1], guid: 'rec-scorekeeper', role: 'scorekeeper', participant: { ...(recorded.response.results![1]!.participant as object), player_id: '9999910' } },
      { ...recorded.response.results![2], guid: 'rec-player-4', participant: { ...(recorded.response.results![2]!.participant as object), player_id: '9999996' } },
    ],
  });

  it('reads every page with no player or role filter and returns players, staff and the organizer record', async () => {
    const recorded = recording('03');
    upstream.use(
      http.get(RECORDS_URL, ({ request }) =>
        HttpResponse.json(new URL(request.url).searchParams.get('page') === '2' ? page2(recorded) : recorded.response),
      ),
    );

    const everyone = await gateway().listTournamentParticipants(T);

    const first = new URL(seen[0]!.url);
    expect(first.pathname).toBe(`/services/core/tournaments/${T}/records`);
    expect(first.searchParams.has('player')).toBe(false);
    expect(first.searchParams.has('role:null')).toBe(false);
    expect(seen).toHaveLength(2);
    expect(everyone.map((p) => [p.playerId, p.role, p.isStaff])).toEqual([
      ['9999991', 'organizer', true],
      ['9999997', 'judge', true],
      ['9999993', null, false],
      ['9999994', null, false],
      ['9999995', null, false],
      ['9999910', 'scorekeeper', true],
      ['9999996', null, false],
    ]);
    expect(everyone[0]).toEqual({ recordId: expect.any(String), playerId: '9999991', role: 'organizer', isStaff: true, name: '<redacted> <redacted>' });
    expect([...keysDeep(everyone)].filter((k) => UPSTREAM_ONLY.includes(k))).toEqual([]);
  });

  it('keeps ids as text (leading zeros, numeric ids), joins names, and keeps a person listed twice', async () => {
    const base = recording('05').response.results![0]!;
    const rec = (guid: string, player_id: unknown, role: string | null, first: string | null, last: string | null) => ({
      ...base,
      guid,
      role,
      player: role === null,
      status: 'withdrawn',
      participant: { ...(base.participant as object), player_id, display_first_name: first, display_last_name: last },
    });
    upstream.use(
      http.get(RECORDS_URL, () =>
        HttpResponse.json(page([rec('r1', 1234, null, 'Ash', null), rec('r2', '0012', 'judge', null, null), rec('r3', '0012', null, 'Misty', 'W')])),
      ),
    );

    expect(await gateway().listTournamentParticipants(T)).toEqual([
      { recordId: 'r1', playerId: '1234', role: null, isStaff: false, name: 'Ash' },
      { recordId: 'r2', playerId: '0012', role: 'judge', isStaff: true, name: '' },
      { recordId: 'r3', playerId: '0012', role: null, isStaff: false, name: 'Misty W' },
    ]);
  });

  it('fails loudly on a page without results, logging no values', async () => {
    upstream.use(http.get(RECORDS_URL, () => HttpResponse.json({ count: 1, next: null, previous: null, rows: [{ name: 'Brock Harrison 9999997' }] })));

    expect((await upstreamError(gateway().listTournamentParticipants(T))).code).toBe('unexpected_shape');
    expect(log.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.warn.mock.calls[0]);
    expect(logged).not.toContain('Brock');
    expect(logged).not.toContain('9999997');
  });

  it('is forbidden with status 403 for a tournament in a league the account has left (spike #67)', async () => {
    upstream.use(
      http.get(RECORDS_URL, () =>
        HttpResponse.json(
          { code: 'op.activity_group.criteria_failure', message: 'The requested action could not be performed due to insufficient access.' },
          { status: 403 },
        ),
      ),
    );

    const err = await upstreamError(gateway().listTournamentParticipants(T));

    expect(err).toMatchObject({ code: 'forbidden', retryable: false, details: { status: 403 } });
  });
});

const R ='00000000-0000-4000-8000-000000000079';
const replay = (n: string) => {
  const r = recording(n);
  return () => (r.response === null ? new HttpResponse(null, { status: r.status }) : HttpResponse.json(r.response, { status: r.status }));
};
const bodyOf = async (i = 0) => JSON.parse(await seen[i]!.text()) as unknown;

describe('assignStaff (S6: POST core/tournaments/{t}/records, one staffer per call)', () => {
  it('sends exactly the recorded body and returns the new record id', async () => {
    upstream.use(http.post(RECORDS_URL, replay('07')));

    const result = await gateway().assignStaff(T, { playerId: pid('9999997'), role: 'judge' });

    expect(result).toEqual({ status: 'assigned', recordId: R });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!.url).pathname).toBe(`/services/core/tournaments/${T}/records`);
    expect(seen[0]!.headers.get('content-type')).toBe('application/json');
    expect(await bodyOf()).toEqual(recording('07').request);
  });

  it.each([
    ['08', 'cannot_duplicate_participant'],
    ['12', 'player_id_must_be_claimed'],
    ['16', 'missing_certification'],
  ])('reports fixture %s as refused with %s, without throwing', async (n, code) => {
    upstream.use(http.post(RECORDS_URL, replay(n)));
    expect(await gateway().assignStaff(T, { playerId: pid('9999914'), role: 'judge' })).toEqual({ status: 'refused', code });
  });

  const refusal = (errors: unknown[], code = 'op.generic.bad_request') => () =>
    HttpResponse.json({ code, message: 'Invalid request.', errors: { body: { 'participant.player_id': errors } } }, { status: 400 });

  it('suggests the id play-tools says to use for a merged player id, without switching to it', async () => {
    upstream.use(
      http.post(RECORDS_URL, refusal([{ code: 'op.player.merged_player_id', attributes: { provided_player_id: '123', actual_player_id: '456' } }])),
    );
    expect(await gateway().assignStaff(T, { playerId: pid('123'), role: 'judge' })).toEqual({
      status: 'refused',
      code: 'merged_player_id',
      suggestedPlayerId: '456',
    });
    expect(seen).toHaveLength(1);
  });

  it('leaves out a suggestion that is not a valid player id', async () => {
    upstream.use(http.post(RECORDS_URL, refusal([{ code: 'op.player.merged_player_id', attributes: { actual_player_id: 'abc' } }])));
    expect(await gateway().assignStaff(T, { playerId: pid('123'), role: 'judge' })).toEqual({ status: 'refused', code: 'merged_player_id' });
  });

  it('passes an unknown refusal code through, and uses the first of several', async () => {
    upstream.use(http.post(RECORDS_URL, refusal([{ code: 'op.activity_record.something_new' }, { code: 'op.player.below_age' }])));
    expect(await gateway().assignStaff(T, { playerId: pid('123'), role: 'judge' })).toEqual({ status: 'refused', code: 'something_new' });
  });

  it('reports a 400 with no reason for this staffer as invalid', async () => {
    upstream.use(http.post(RECORDS_URL, () => HttpResponse.json({ code: 'op.generic.bad_request', message: 'Invalid request.' }, { status: 400 })));
    expect(await gateway().assignStaff(T, { playerId: pid('123'), role: 'judge' })).toEqual({ status: 'invalid', code: 'bad_request' });
  });

  it('fails loudly on a 400 that is not the OP error envelope', async () => {
    upstream.use(http.post(RECORDS_URL, () => new HttpResponse('<h1>Bad Request</h1>', { status: 400, headers: { 'content-type': 'text/html' } })));
    expect((await upstreamError(gateway().assignStaff(T, { playerId: pid('123'), role: 'judge' }))).code).toBe('unexpected_shape');
  });

  it('fails loudly on a 201 without a record id (the staffer may be assigned: callers re-read)', async () => {
    upstream.use(http.post(RECORDS_URL, () => HttpResponse.json({ id: 1 }, { status: 201 })));
    expect((await upstreamError(gateway().assignStaff(T, { playerId: pid('123'), role: 'judge' }))).code).toBe('unexpected_shape');
    expect(seen).toHaveLength(1);
  });
});

describe('changeStaffRole (S6: PATCH core/tournaments/{t}/records/{r})', () => {
  it('sends the recorded JSON-Patch body and reports changed', async () => {
    upstream.use(http.patch(RECORD_URL, replay('10')));

    expect(await gateway().changeStaffRole(T, R, 'administration')).toBe('changed');
    expect(seen[0]!.method).toBe('PATCH');
    expect(new URL(seen[0]!.url).pathname).toBe(`/services/core/tournaments/${T}/records/${R}`);
    expect(await bodyOf()).toEqual(recording('10').request);
  });

  it('reports not_found for a record play-tools no longer has', async () => {
    upstream.use(http.patch(RECORD_URL, () => HttpResponse.json({ code: 'op.generic.not_found' }, { status: 404 })));
    expect(await gateway().changeStaffRole(T, R, 'judge')).toBe('not_found');
  });
});

describe('unassignStaff (S6: DELETE core/tournaments/{t}/records/{r})', () => {
  it('sends the recorded legacy_alias body and reports removed', async () => {
    upstream.use(http.delete(RECORD_URL, replay('06')));

    expect(await gateway().unassignStaff(T, R, pid('9999997'))).toBe('removed');
    expect(seen[0]!.method).toBe('DELETE');
    expect(await bodyOf()).toEqual(recording('06').request);
  });

  it('reports not_found for a record play-tools no longer has', async () => {
    upstream.use(http.delete(RECORD_URL, () => HttpResponse.json({ code: 'op.generic.not_found' }, { status: 404 })));
    expect(await gateway().unassignStaff(T, R, pid('9999997'))).toBe('not_found');
  });
});

describe('errors on every tournament call', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['listTournaments', () => gateway().listTournaments()],
    ['getTournament', () => gateway().getTournament(T)],
    ['listTournamentParticipants', () => gateway().listTournamentParticipants(T)],
    ['assignStaff', () => gateway().assignStaff(T, { playerId: pid('9999914'), role: 'judge' })],
    ['changeStaffRole', () => gateway().changeStaffRole(T, R, 'judge')],
    ['unassignStaff', () => gateway().unassignStaff(T, R, pid('9999914'))],
  ];
  const everywhere = (reply: () => Response) => upstream.use(http.all(`${API}core/*`, reply));

  it.each(calls)('%s: a tournament past its window (423, fixture 21) is tournament_locked and not retryable', async (_, call) => {
    const locked = recording('21');
    everywhere(() => HttpResponse.json(locked.response, { status: 423 }));
    const err = await upstreamError(call());
    expect(err.code).toBe('tournament_locked');
    expect(err.retryable).toBe(false);
  });

  it.each(calls)('%s: 403 (staff management is organizer-only) is forbidden', async (_, call) => {
    everywhere(() => HttpResponse.json({ code: 'op.generic.forbidden' }, { status: 403 }));
    expect((await upstreamError(call())).code).toBe('forbidden');
  });

  it.each(calls)('%s: 502 is unavailable and retryable, never retried by the adapter', async (_, call) => {
    everywhere(() => new HttpResponse('<h1>Bad Gateway</h1>', { status: 502 }));
    const err = await upstreamError(call());
    expect(err.code).toBe('unavailable');
    expect(err.retryable).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it.each(calls)('%s: 429 is rate_limited with Retry-After', async (_, call) => {
    everywhere(() => new HttpResponse(null, { status: 429, headers: { 'retry-after': '7' } }));
    const err = await upstreamError(call());
    expect(err.code).toBe('rate_limited');
    expect(err.details.retryAfterMs).toBe(7000);
  });

  it.each(calls)('%s: a network failure is unavailable', async (_, call) => {
    everywhere(() => HttpResponse.error());
    expect((await upstreamError(call())).code).toBe('unavailable');
  });

  it.each(calls)('%s: a failing token provider stops the call before anything is sent', async (_, call) => {
    getAccessToken.mockRejectedValueOnce(new PokemonUpstreamError('needs_reconnect', 'reconnect'));
    everywhere(() => HttpResponse.json({}));
    expect((await upstreamError(call())).code).toBe('needs_reconnect');
    expect(seen).toHaveLength(0);
  });
});

describe('local checks before any call', () => {
  const badIds = ['../x', 'a/b', 'a?b', 'a#b', '%2e%2e', 'x'.repeat(65), ''];

  it.each(badIds)('refuses tournament id %j on every method', async (bad) => {
    for (const call of [
      () => gateway().getTournament(bad),
      () => gateway().listTournamentParticipants(bad),
      () => gateway().assignStaff(bad, { playerId: pid('1'), role: 'judge' }),
      () => gateway().changeStaffRole(bad, R, 'judge'),
      () => gateway().unassignStaff(bad, R, pid('1')),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(TypeError);
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it.each(badIds)('refuses record id %j', async (bad) => {
    await expect(gateway().changeStaffRole(T, bad, 'judge')).rejects.toBeInstanceOf(TypeError);
    await expect(gateway().unassignStaff(T, bad, pid('1'))).rejects.toBeInstanceOf(TypeError);
    expect(seen).toHaveLength(0);
  });

  it('refuses a player id that is not digits only', async () => {
    await expect(gateway().assignStaff(T, { playerId: pid('12a'), role: 'judge' })).rejects.toBeInstanceOf(TypeError);
    await expect(gateway().unassignStaff(T, R, pid(' '))).rejects.toBeInstanceOf(TypeError);
    expect(seen).toHaveLength(0);
  });

  it('refuses organizer, or any role play-tools does not offer', async () => {
    for (const role of ['organizer', 'Judge', 'generic-staff', '']) {
      await expect(gateway().assignStaff(T, { playerId: pid('1'), role: role as 'judge' })).rejects.toBeInstanceOf(TypeError);
      await expect(gateway().changeStaffRole(T, R, role as 'judge')).rejects.toBeInstanceOf(TypeError);
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });
});

describe('mapping cost', () => {
  it('maps a 500-record page in well under 50 ms', async () => {
    const base = recording('05').response.results![0]!;
    const records = Array.from({ length: 500 }, (_, i) => ({
      ...base,
      guid: `r-${i}`,
      role: i % 10 === 0 ? 'judge' : null,
      player: i % 10 !== 0,
      participant: { ...(base.participant as object), player_id: String(1_000_000 + i) },
    }));
    const body = page(records);
    upstream.use(http.get(RECORDS_URL, () => HttpResponse.json(body)));
    await gateway().listTournamentParticipants(T); // warm up

    const started = performance.now();
    const mapped = await gateway().listTournamentParticipants(T);
    const fetchFree = performance.now() - started;

    expect(mapped).toHaveLength(500);
    // Includes msw's in-process round trip, so this bounds mapping from above.
    expect(fetchFree).toBeLessThan(50);
  });
});
