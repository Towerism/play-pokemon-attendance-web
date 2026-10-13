import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PokemonUpstreamError } from '../../ports/errors';
import type { NewTournament } from '../../ports/play-tools-gateway';
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
  response: unknown;
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
    const r = recorded.request as Record<string, never>;

    const created = await gateway().createTournament(
      newTournament({
        groupId: r.activity_group_id,
        name: r.name,
        venueId: r.address_id,
        startsAt: new Date(r.start_date_v2),
        contact: r.contact_information,
      }),
    );

    expect(created).toEqual({ tournamentId: T });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('POST');
    expect(path(seen[0]!)).toBe('/services/core/tournament');
    expect(await sentJson(seen[0]!)).toEqual(recorded.request);
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
