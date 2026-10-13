import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PokemonUpstreamError } from '../../ports/errors';
import type { Contact, NewTournament } from '../../ports/play-tools-gateway';
import type { TokenProvider } from '../../ports/token-provider';
import { createPlayToolsHttpAdapter } from './gateway';

/**
 * Tournament lifecycle and TDF results (ADR-0010, ADR-0011, architecture §4.3), pinned to the S8 part 2
 * recordings in `__fixtures__/s8/` (`{ method, path, query, status, request, response }`).
 */
const S8 = join(import.meta.dirname, '__fixtures__', 's8');
interface Recording {
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  request: Record<string, unknown> | null;
  response: JsonBodyType;
}
const recording = (n: string): Recording => {
  const file = readdirSync(S8).find((f) => f.startsWith(`${n}.`));
  if (!file) throw new Error(`no S8 fixture ${n}`);
  return JSON.parse(readFileSync(join(S8, file), 'utf8')) as Recording;
};
const body = (n: string) => recording(n).response as Record<string, unknown>;

const API = 'https://api.play.pokemon.com/services/';
/** The recorded token subject (S8: the users path) and the same id as a hyphenated guid (the organizer). */
const SUB = '00000000000040008000000000000043';
const USER_GUID = '00000000-0000-4000-8000-000000000043';
const GROUP = '00000000-0000-4000-8000-000000000002';
const T = '00000000-0000-4000-8000-000000000057';
const DISPLAY_ID = '26-10-900041';
const UPLOAD = '00000000-0000-4000-8000-000000000067';

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

let subject = SUB;
const getAccessToken = vi.fn(async () => ({ value: 'access-jwt', expiresAt: new Date('2099-01-01T00:00:00Z'), subject }));
const tokens: TokenProvider = { getAccessToken };
const log = { warn: vi.fn() };
beforeEach(() => {
  subject = SUB;
  getAccessToken.mockClear();
  log.warn.mockClear();
});
const gateway = (opts: { writeTimeoutMs?: number } = {}) => createPlayToolsHttpAdapter({ tokens, connectionId: 1, log, ...opts });

async function upstreamError(promise: Promise<unknown>): Promise<PokemonUpstreamError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PokemonUpstreamError);
  return err as PokemonUpstreamError;
}

const path = (r: Request) => new URL(r.url).pathname;
const query = (r: Request) => Object.fromEntries(new URL(r.url).searchParams);

describe('getTournament: the S8 fields', () => {
  it('reads a premier event with registration, contact and organizer name (recording 02)', async () => {
    upstream.use(http.get(`${API}core/tournament/:t`, () => HttpResponse.json(body('02'))));

    const t = await gateway().getTournament('00000000-0000-4000-8000-000000000001');

    expect(t).toMatchObject({
      organizerPlayerId: '9999992',
      organizerName: '<redacted> <redacted>',
      applicationState: 'sanctioned',
      activityState: 'pending',
      category: 'tcg_lim',
      series: { id: '00000000000040008000000000000044', name: '<redacted>' },
      venue: null,
      contact: { email: null, phone: '<redacted>' },
      registration: { startsAt: new Date('2026-10-25T21:00:00Z'), endsAt: new Date('2026-10-25T21:30:00Z') },
      onSiteAdmission: '35',
      thirdPartyRegistrationUrl: null,
      details: null,
      eventWebsite: null,
    });
  });

  it('reads a custom event with nothing optional set (recording 17)', async () => {
    upstream.use(http.get(`${API}core/tournament/:t`, () => HttpResponse.json(body('17'))));

    const t = await gateway().getTournament(T);

    expect(t).toMatchObject({ category: 'tcg_std', series: null, registration: null, onSiteAdmission: null, displayId: DISPLAY_ID });
  });

  it('reads a completed upload as play-tools reports it (recording 40)', async () => {
    upstream.use(http.get(`${API}core/tournament/:t`, () => HttpResponse.json(body('40'))));

    expect(await gateway().getTournament(T)).toMatchObject({ status: 'complete', activityState: 'completed', applicationState: 'sanctioned' });
  });

  it('takes the venue from an address object, and only from one', async () => {
    const read = (address: unknown) => upstream.use(http.get(`${API}core/tournament/:t`, () => HttpResponse.json({ ...body('17'), address })));

    read({ guid: 'venue-1', timezone: 'America/Chicago', formatted_address: 'x' });
    expect((await gateway().getTournament(T)).venue).toEqual({ id: 'venue-1', timeZone: 'America/Chicago' });
    read({ timezone: 'America/Chicago' });
    expect((await gateway().getTournament(T)).venue).toEqual({ id: null, timeZone: 'America/Chicago' });
    read({ street: 'no id or zone' });
    expect((await gateway().getTournament(T)).venue).toBeNull();
    read(null);
    expect((await gateway().getTournament(T)).venue).toBeNull();
  });

  it('gives no organizer name when play-tools has neither part, and one part when it has one', async () => {
    const read = (first: string | null, last: string | null) =>
      upstream.use(
        http.get(`${API}core/tournament/:t`, () =>
          HttpResponse.json({ ...body('17'), organizer: { ...(body('17').organizer as object), first_name: first, last_name: last } }),
        ),
      );

    read(null, '  ');
    expect((await gateway().getTournament(T)).organizerName).toBeNull();
    read(' Ash ', null);
    expect((await gateway().getTournament(T)).organizerName).toBe('Ash');
  });

  it('maps fields an older read leaves out to null', async () => {
    const S8_FIELDS = ['application_state', 'activity_state', 'category', 'series', 'address', 'contact_information', 'registration_start_date_v2',
      'registration_end_date_v2', 'on_site_admission', 'third_party_registration_website', 'details', 'event_website'];
    const older = Object.fromEntries(Object.entries(body('17')).filter(([k]) => !S8_FIELDS.includes(k)));
    upstream.use(http.get(`${API}core/tournament/:t`, () => HttpResponse.json({ ...older, organizer: { player_id: '9999992' } })));

    expect(await gateway().getTournament(T)).toMatchObject({
      organizerName: null,
      applicationState: null,
      activityState: null,
      category: null,
      series: null,
      venue: null,
      contact: { email: null, phone: null },
      registration: null,
      onSiteAdmission: null,
      thirdPartyRegistrationUrl: null,
      details: null,
      eventWebsite: null,
    });
  });

  it('needs both registration dates to report a registration window', async () => {
    upstream.use(http.get(`${API}core/tournament/:t`, () => HttpResponse.json({ ...body('17'), registration_start_date_v2: '2026-10-12T04:00:00Z' })));

    expect((await gateway().getTournament(T)).registration).toBeNull();
  });
});

describe('listSeries (S8 recording 07)', () => {
  it('reads the league\'s series as the professor, with formats, tags and per-country windows', async () => {
    upstream.use(http.get(`${API}core/users/:sub/activity_groups/:ag/series/`, () => HttpResponse.json(body('07'))));

    const series = await gateway().listSeries(GROUP);

    expect(path(seen[0]!)).toBe(`/services/core/users/${SUB}/activity_groups/${GROUP}/series/`);
    expect(series).toHaveLength(5);
    expect(series[0]).toMatchObject({
      id: '00000000000040008000000000000044',
      product: 'tcg',
      categories: ['tcg_lim'],
      tags: ['prerelease'],
      playTemplate: 'PRERELEASE',
    });
    expect(series[0]!.windows.US).toEqual({ from: '2026-10-24', to: '2026-11-01' });
    expect(series.map((s) => s.tags)).toContainEqual(['championship_series', 'league_cup']);
    expect(series[4]!.playTemplate).toBeNull();
  });

  it('leaves out a disabled series and one that is not for tournaments', async () => {
    const [first, second, ...rest] = body('07').results as Record<string, unknown>[];
    upstream.use(
      http.get(`${API}core/users/:sub/activity_groups/:ag/series/`, () =>
        HttpResponse.json({ results: [{ ...first, is_enabled: false }, { ...second, supported_types: ['play_session'] }, ...rest] }),
      ),
    );

    expect((await gateway().listSeries(GROUP)).map((s) => s.id)).toEqual(rest.map((s) => s.guid));
  });

  it('follows a next page on the same host and refuses one on another', async () => {
    const [first, second] = body('07').results as Record<string, unknown>[];
    upstream.use(
      http.get(`${API}core/users/:sub/activity_groups/:ag/series/`, ({ request }) =>
        new URL(request.url).searchParams.get('page') === '2'
          ? HttpResponse.json({ results: [second], next: null })
          : HttpResponse.json({ results: [first], next: `${API}core/users/${SUB}/activity_groups/${GROUP}/series/?page=2` }),
      ),
    );
    expect(await gateway().listSeries(GROUP)).toHaveLength(2);

    upstream.use(
      http.get(`${API}core/users/:sub/activity_groups/:ag/series/`, () => HttpResponse.json({ results: [first], next: 'https://evil.example/series/?page=2' })),
    );
    expect((await upstreamError(gateway().listSeries(GROUP))).code).toBe('unexpected_shape');
  });
});

describe('listFormats (S8 recording 06)', () => {
  it('lists each product with its formats for the country', async () => {
    upstream.use(http.get(`${API}core/products`, () => HttpResponse.json(body('06'))));

    const formats = await gateway().listFormats('US');

    expect(query(seen[0]!)).toEqual({ country: 'US' });
    expect(formats.map((f) => f.product)).toEqual(['pgo', 'tcg', 'vg']);
    expect(formats[1]).toEqual({ product: 'tcg', categories: ['tcg_std', 'tcg_exp', 'tcg_lim', 'tcg_lim_ditto', 'tcg_unl', 'tcg_glc', 'tcg_other'] });
  });

  it('gives a product with no format list no formats', async () => {
    upstream.use(http.get(`${API}core/products`, () => HttpResponse.json({ results: ['tcg'], product_categories: {} })));

    expect(await gateway().listFormats('US')).toEqual([{ product: 'tcg', categories: [] }]);
  });
});

describe('listVenues (S8 recording 08)', () => {
  it('reads the professor\'s address book by their user guid, for the league and country', async () => {
    upstream.use(http.get(`${API}core/v2/users/:user/address_book`, () => HttpResponse.json(body('08'))));

    const venues = await gateway().listVenues(GROUP, 'US');

    expect(path(seen[0]!)).toBe(`/services/core/v2/users/${USER_GUID}/address_book`);
    expect(query(seen[0]!)).toEqual({ country: 'US', activity_group_id: GROUP });
    expect(venues).toEqual([
      { id: '00000000-0000-4000-8000-000000000051', name: '<redacted>', formattedAddress: '<redacted>', country: 'US', timeZone: 'America/Chicago' },
    ]);
  });

  it('takes the country from op_country first', async () => {
    const [venue] = body('08').results as Record<string, unknown>[];
    upstream.use(http.get(`${API}core/v2/users/:user/address_book`, () => HttpResponse.json({ results: [{ ...venue, op_country: 'CA', country: 'US' }] })));

    expect((await gateway().listVenues(GROUP, 'US'))[0]!.country).toBe('CA');
  });

  it('uses an already hyphenated subject as it is', async () => {
    subject = USER_GUID;
    upstream.use(http.get(`${API}core/v2/users/:user/address_book`, () => HttpResponse.json(body('08'))));

    await gateway().listVenues(GROUP, 'US');

    expect(path(seen[0]!)).toBe(`/services/core/v2/users/${USER_GUID}/address_book`);
  });

  it('refuses a subject that is not a user guid, before any call', async () => {
    subject = 'not-a-guid';

    expect((await upstreamError(gateway().listVenues(GROUP, 'US'))).code).toBe('unexpected_shape');
    expect(seen).toHaveLength(0);
  });
});

describe('listResultsUploads (S8 recordings 12 and 41)', () => {
  it('lists every upload oldest first, a refused one with its errors in readable words', async () => {
    const [refused, accepted] = body('12') as unknown as Record<string, unknown>[];
    upstream.use(http.get(`${API}triumph/tournament/:display/uploads/`, () => HttpResponse.json([accepted, refused])));

    const uploads = await gateway().listResultsUploads('26-09-900011');

    expect(path(seen[0]!)).toBe('/services/triumph/tournament/26-09-900011/uploads/');
    expect(uploads.map((u) => [u.uploadId, u.accepted])).toEqual([
      ['00000000-0000-4000-8000-000000000053', false],
      ['00000000-0000-4000-8000-000000000054', true],
    ]);
    expect(uploads[0]!.uploadedAt).toEqual(new Date(1789529388079));
    expect(uploads[0]!.errors).toEqual([
      { code: 'ORGANIZER_ID_MISMATCH', message: expect.stringMatching(/organizer/i), detail: '9999993 !== 9999992' },
    ]);
  });

  it('lists the upload this run confirmed', async () => {
    upstream.use(http.get(`${API}triumph/tournament/:display/uploads/`, () => HttpResponse.json(body('41'))));

    expect(await gateway().listResultsUploads(DISPLAY_ID)).toEqual([
      { uploadId: UPLOAD, accepted: true, errors: [], uploadedAt: new Date(1791871738358) },
    ]);
  });
});

const sentJson = async (r: Request) => (await r.clone().json()) as Record<string, unknown>;

describe('createTournament (S8 recording 16)', () => {
  it('sends the recorded create body as the professor and returns the new tournament id', async () => {
    const recorded = recording('16');
    upstream.use(http.post(`${API}core/tournament`, () => HttpResponse.json(recorded.response, { status: 201 })));
    const r = recorded.request as unknown as { activity_group_id: string; name: string; start_date_v2: string; contact_information: Contact };

    const created = await gateway().createTournament(
      newTournament({
        groupId: r.activity_group_id,
        name: r.name,
        startsAt: new Date(r.start_date_v2),
        contact: r.contact_information,
      }),
    );

    expect(created).toEqual({ tournamentId: T });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(path(seen[0]!)).toBe('/services/core/tournament');
    // The sanitizer redacted the recorded venue id, which the local check would refuse; a real-shaped one stands in.
    expect(await sentJson(seen[0]!)).toEqual({ ...recorded.request, address_id: newTournament().venueId });
  });

  it('sends the optional settings under their play-tools names, and nothing else', async () => {
    upstream.use(http.post(`${API}core/tournament`, () => HttpResponse.json({ guid: T }, { status: 201 })));

    await gateway().createTournament(
      newTournament({
        seriesId: '00000000000040008000000000000048',
        registration: { startsAt: new Date('2026-10-12T04:00:00.000Z'), endsAt: new Date('2026-10-12T04:30:00.000Z') },
        onSiteAdmission: 'FREE',
        thirdPartyRegistrationUrl: 'https://register.example',
        details: 'Bring a deck',
        eventWebsite: 'https://shop.example',
      }),
    );

    expect(await sentJson(seen[0]!)).toEqual({
      name: 'Tuesday League Challenge',
      activity_group_id: GROUP,
      organizer_id: USER_GUID,
      product: 'tcg',
      category: 'tcg_std',
      series_guid: '00000000000040008000000000000048',
      address_id: '00000000-0000-4000-8000-000000000051',
      start_date_v2: '2026-10-12T05:00:00Z',
      contact_information: { email: 'league@example.com', phone: null },
      activity_division_info: { juniors: null, masters: null, seniors: null, all: null },
      registration_start_date_v2: '2026-10-12T04:00:00Z',
      registration_end_date_v2: '2026-10-12T04:30:00Z',
      on_site_admission: 'FREE',
      third_party_registration_website: 'https://register.example',
      details: 'Bring a deck',
      event_website: 'https://shop.example',
    });
  });
});

describe('editTournament (S8 recordings 19–25: a partial PATCH changes only what it sends)', () => {
  it.each(['19', '21', '23', '25'])('sends recording %s\'s body alone, with no read first', async (n) => {
    const recorded = recording(n);
    upstream.use(http.patch(`${API}core/tournament/:t/`, () => new HttpResponse(null, { status: 204 })));
    const r = recorded.request as Record<string, string>;
    const changes = 'details' in r ? { details: r.details } : { startsAt: new Date(r.start_date_v2!) };

    expect(await gateway().editTournament(T, changes)).toBe('edited');

    expect(seen.map((s) => [s.method, path(s)])).toEqual([['PATCH', `/services/core/tournament/${T}/`]]);
    expect(await sentJson(seen[0]!)).toEqual(recorded.request);
  });

  it('sends a cleared registration, a new contact and a new venue under their play-tools names', async () => {
    upstream.use(http.patch(`${API}core/tournament/:t/`, () => new HttpResponse(null, { status: 204 })));

    await gateway().editTournament(T, { registration: null, contact: { email: null, phone: '555-0100' }, venueId: 'venue-2' });

    expect(await sentJson(seen[0]!)).toEqual({
      registration_start_date_v2: null,
      registration_end_date_v2: null,
      contact_information: { email: null, phone: '555-0100' },
      address_id: 'venue-2',
    });
  });

  it('moves a tournament and its registration window together (a reschedule)', async () => {
    upstream.use(http.patch(`${API}core/tournament/:t/`, () => new HttpResponse(null, { status: 204 })));

    await gateway().editTournament(T, {
      startsAt: new Date('2026-10-19T23:00:00Z'),
      registration: { startsAt: new Date('2026-10-19T22:00:00Z'), endsAt: new Date('2026-10-19T22:30:00Z') },
    });

    expect(await sentJson(seen[0]!)).toEqual({
      start_date_v2: '2026-10-19T23:00:00Z',
      registration_start_date_v2: '2026-10-19T22:00:00Z',
      registration_end_date_v2: '2026-10-19T22:30:00Z',
    });
  });
});

describe('cancelTournament (S8 recording 30)', () => {
  it('sends the recorded cancel and nothing else', async () => {
    upstream.use(http.patch(`${API}core/tournament/:t/`, () => new HttpResponse(null, { status: 204 })));

    expect(await gateway().cancelTournament(T)).toBe('cancelled');

    expect(seen.map((s) => [s.method, path(s)])).toEqual([['PATCH', `/services/core/tournament/${T}/`]]);
    expect(await sentJson(seen[0]!)).toEqual(recording('30').request);
  });
});

/** A made-up TDF; the player's name is not ASCII, so the encoding is checked. */
const tdfFile = () => '<?xml version="1.0" encoding="UTF-8"?><tournament><data><id>26-10-900041</id></data><player><firstname>Zoë</firstname></player></tournament>';

describe('validateResults (S8 recording 37)', () => {
  it('sends the file as base64 of its UTF-8 bytes for the display id and returns the upload id', async () => {
    upstream.use(http.post(`${API}triumph/tdf/`, () => HttpResponse.json(body('37'))));

    const result = await gateway().validateResults(DISPLAY_ID, tdfFile());

    expect(result).toEqual({ uploadId: UPLOAD, errors: [] });
    expect(path(seen[0]!)).toBe('/services/triumph/tdf/');
    const sent = await sentJson(seen[0]!);
    expect(sent).toEqual({ kind: 'tdf', tournament_id: DISPLAY_ID, payload: expect.any(String) });
    expect(Buffer.from(sent.payload as string, 'base64').toString('utf8')).toBe(tdfFile());
  });

  it.each([200, 400])('reads a validation that found errors (HTTP %i) in readable words', async (status) => {
    const errors = [{ type: 'STAFF_PLAYERS_ERROR', message: 'x' }, 'SOME_NEW_ERROR'];
    upstream.use(http.post(`${API}triumph/tdf/`, () => HttpResponse.json({ ...body('37'), errors }, { status })));

    const result = await gateway().validateResults(DISPLAY_ID, tdfFile());

    expect(result.uploadId).toBe(UPLOAD);
    expect(result.errors).toEqual([
      { code: 'STAFF_PLAYERS_ERROR', message: 'Someone in the file is on the tournament staff.', detail: 'x' },
      { code: 'SOME_NEW_ERROR', message: 'SOME_NEW_ERROR', detail: null },
    ]);
  });
});

describe('confirmResults (S8 recording 39)', () => {
  it('confirms the upload with the tournament id, not its display id', async () => {
    upstream.use(http.put(`${API}triumph/:upload/confirm/`, () => new HttpResponse(null, { status: 202 })));

    expect(await gateway().confirmResults(UPLOAD, T)).toBe('confirmed');

    expect(seen.map((s) => [s.method, path(s)])).toEqual([['PUT', `/services/triumph/${UPLOAD}/confirm/`]]);
    expect(await sentJson(seen[0]!)).toEqual(recording('39').request);
  });
});

/** Every write, answering with whatever `reply` gives for any tournament or TDF path. */
const writes: [string, () => Promise<unknown>][] = [
  ['createTournament', () => gateway().createTournament(newTournament())],
  ['editTournament', () => gateway().editTournament(T, { details: 'x' })],
  ['cancelTournament', () => gateway().cancelTournament(T)],
  ['validateResults', () => gateway().validateResults(DISPLAY_ID, tdfFile())],
  ['confirmResults', () => gateway().confirmResults(UPLOAD, T)],
];
const everywhere = (reply: () => Response | Promise<Response>) => upstream.use(http.all(`${API}*`, reply));
const CORRELATION = { 'x-correlation-id': 'corr-123' };

describe('refusals and failures on every write', () => {
  it('a refused create (recording 15) is `refused` with play-tools\' message, its field errors and the correlation id', async () => {
    const recorded = recording('15');
    upstream.use(http.post(`${API}core/tournament`, () => HttpResponse.json(recorded.response, { status: 400, headers: CORRELATION })));

    const err = await upstreamError(gateway().createTournament(newTournament()));

    expect(err.code).toBe('refused');
    expect(err.retryable).toBe(false);
    expect(err.details.status).toBe(400);
    expect(err.details.upstream).toEqual({
      code: 'op.generic.bad_request',
      message: 'Invalid request. (activity_division_info: This field may not be null.)',
      correlationId: 'corr-123',
    });
    expect(err.message).toContain('This field may not be null.');
  });

  const matrix: [number, string][] = [
    [401, 'forbidden'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'refused'],
    [422, 'refused'],
    [423, 'tournament_locked'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ];
  describe.each(writes)('%s', (_, call) => {
    it.each(matrix)('HTTP %i is %s, with the status and correlation id, after one request', async (status, code) => {
      everywhere(() => HttpResponse.json({ code: 'op.generic.x', message: 'No.' }, { status, headers: CORRELATION }));

      const err = await upstreamError(call());

      expect(err.code).toBe(code);
      expect(err.details.status).toBe(status);
      expect(err.details.upstream).toEqual({ code: 'op.generic.x', message: 'No.', correlationId: 'corr-123' });
      expect(seen).toHaveLength(1);
    });

    it('a 400 that is not JSON is refused, with only the correlation id', async () => {
      everywhere(() => new HttpResponse('<h1>Bad Request</h1>', { status: 400, headers: { 'content-type': 'text/html', ...CORRELATION } }));

      const err = await upstreamError(call());

      expect(err.code).toBe('refused');
      expect(err.details.upstream).toEqual({ correlationId: 'corr-123' });
    });

    it('a network failure is unavailable', async () => {
      everywhere(() => HttpResponse.error());

      expect((await upstreamError(call())).code).toBe('unavailable');
    });
  });

  it.each(writes.map(([name]) => name))('%s: a write play-tools never answers times out as unavailable', async (name) => {
    everywhere(() => new Promise<Response>(() => {}));
    const call: Record<string, () => Promise<unknown>> = {
      createTournament: () => gateway({ writeTimeoutMs: 20 }).createTournament(newTournament()),
      editTournament: () => gateway({ writeTimeoutMs: 20 }).editTournament(T, { details: 'x' }),
      cancelTournament: () => gateway({ writeTimeoutMs: 20 }).cancelTournament(T),
      validateResults: () => gateway({ writeTimeoutMs: 20 }).validateResults(DISPLAY_ID, tdfFile()),
      confirmResults: () => gateway({ writeTimeoutMs: 20 }).confirmResults(UPLOAD, T),
    };

    const err = await upstreamError(call[name]!());

    expect(err.code).toBe('unavailable');
    expect(err.retryable).toBe(true);
  });

  it('a 400 from validate without an upload id is refused', async () => {
    upstream.use(http.post(`${API}triumph/tdf/`, () => HttpResponse.json({ code: 'op.generic.bad_request', message: 'Invalid request.' }, { status: 400 })));

    expect((await upstreamError(gateway().validateResults(DISPLAY_ID, tdfFile()))).code).toBe('refused');
  });

  it('a validate error of an unknown shape fails loudly', async () => {
    upstream.use(http.post(`${API}triumph/tdf/`, () => HttpResponse.json({ ...body('37'), errors: [42] })));

    expect((await upstreamError(gateway().validateResults(DISPLAY_ID, tdfFile()))).code).toBe('unexpected_shape');
  });

  it('a create answered without its id fails loudly, logging only the outline', async () => {
    upstream.use(http.post(`${API}core/tournament`, () => HttpResponse.json({ status: 'secret-value' }, { status: 201 })));

    expect((await upstreamError(gateway().createTournament(newTournament({ name: 'Private Name' })))).code).toBe('unexpected_shape');

    expect(log.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(log.warn.mock.calls[0]);
    expect(logged).toContain('status');
    expect(logged).not.toContain('secret-value');
    expect(logged).not.toContain('Private Name');
  });

  it('a token failure is passed through, with nothing sent', async () => {
    getAccessToken.mockRejectedValueOnce(new PokemonUpstreamError('needs_reconnect', 'Reconnect.'));

    expect((await upstreamError(gateway().createTournament(newTournament()))).code).toBe('needs_reconnect');
    expect(seen).toHaveLength(0);
  });
});

describe('inputs checked before anything is sent', () => {
  const long = (n: number) => 'x'.repeat(n);
  const refusedLocally: [string, () => Promise<unknown>][] = [
    ['a tournament id that could change the path', () => gateway().editTournament('../x', { details: 'x' })],
    ['a cancel of a malformed tournament id', () => gateway().cancelTournament('a/b')],
    ['a malformed league id (create)', () => gateway().createTournament(newTournament({ groupId: 'a b' }))],
    ['a malformed series id', () => gateway().createTournament(newTournament({ seriesId: 'a/b' }))],
    ['a malformed venue id', () => gateway().createTournament(newTournament({ venueId: '' }))],
    ['a malformed venue id (edit)', () => gateway().editTournament(T, { venueId: 'a?b' })],
    ['a malformed upload id', () => gateway().confirmResults('a/b', T)],
    ['a malformed tournament id (confirm)', () => gateway().confirmResults(UPLOAD, '../x')],
    ['a malformed display id (validate)', () => gateway().validateResults('26-10-90004', tdfFile())],
    ['a malformed display id (uploads)', () => gateway().listResultsUploads('L5012')],
    ['a malformed league id (series)', () => gateway().listSeries('a/b')],
    ['a malformed league id (venues)', () => gateway().listVenues('a/b', 'US')],
    ['a malformed country (venues)', () => gateway().listVenues(GROUP, 'us')],
    ['a malformed country (formats)', () => gateway().listFormats('USA')],
    ['an unknown product', () => gateway().createTournament(newTournament({ product: 'mtg' as never }))],
    ['a malformed format', () => gateway().createTournament(newTournament({ category: 'TCG STD' }))],
    ['a malformed format (edit)', () => gateway().editTournament(T, { category: '' })],
    ['an empty name', () => gateway().createTournament(newTournament({ name: '   ' }))],
    ['a name over 80 characters', () => gateway().createTournament(newTournament({ name: long(81) }))],
    ['a name over 80 characters (edit)', () => gateway().editTournament(T, { name: long(81) })],
    ['details over 30,000 characters', () => gateway().editTournament(T, { details: long(30_001) })],
    ['a contact with neither email nor phone', () => gateway().createTournament(newTournament({ contact: { email: null, phone: '' } }))],
    ['a contact with neither email nor phone (edit)', () => gateway().editTournament(T, { contact: { email: '', phone: null } })],
    ['an invalid start', () => gateway().createTournament(newTournament({ startsAt: new Date('nope') }))],
    ['an invalid start (edit)', () => gateway().editTournament(T, { startsAt: new Date(Number.NaN) })],
    [
      'a registration that ends before it starts',
      () => gateway().editTournament(T, { registration: { startsAt: new Date('2026-10-12T05:00:00Z'), endsAt: new Date('2026-10-12T05:00:00Z') } }),
    ],
    ['an edit with no changes', () => gateway().editTournament(T, {})],
    ['an empty TDF', () => gateway().validateResults(DISPLAY_ID, '')],
  ];

  it.each(refusedLocally)('%s throws TypeError, with no token fetched and nothing sent', async (_, call) => {
    await expect(call()).rejects.toBeInstanceOf(TypeError);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it('takes a name of exactly 80 characters and details of exactly 30,000', async () => {
    upstream.use(http.post(`${API}core/tournament`, () => HttpResponse.json({ guid: T }, { status: 201 })));

    await gateway().createTournament(newTournament({ name: long(80), details: long(30_000) }));

    expect(seen).toHaveLength(1);
  });
});

/** Made-up settings for a new tournament, overridable per test. */
export function newTournament(overrides: Partial<NewTournament> = {}): NewTournament {
  return {
    groupId: GROUP,
    name: 'Tuesday League Challenge',
    product: 'tcg',
    category: 'tcg_std',
    seriesId: null,
    venueId: '00000000-0000-4000-8000-000000000051',
    startsAt: new Date('2026-10-12T05:00:00Z'),
    contact: { email: 'league@example.com', phone: null },
    ...overrides,
  };
}
