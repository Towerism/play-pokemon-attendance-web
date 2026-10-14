import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlayToolsHttpAdapter } from '../../server/modules/pokemon/adapters/play-tools/gateway';
import { PokemonUpstreamError } from '../../server/modules/pokemon/ports/errors';
import type { NewTournament, PlayToolsGateway } from '../../server/modules/pokemon/ports/play-tools-gateway';
import { FAKE_SUB, type FakePokemon, fakeTournament, startFakePokemon } from '../server/fake-pokemon';

// The fake's tournament lifecycle and TDF calls (S8 part 2), driven through the real play-tools adapter, so the
// server and E2E tests for M9 exercise the recorded contract.

const ORGANIZER = '9999991';
const GROUP = 'group-1';

let fake: FakePokemon;
let gateway: PlayToolsGateway;

async function login(code = 'c'): Promise<PlayToolsGateway> {
  const res = await fetch(`${fake.url}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'op-tools-app', code, code_verifier: 'v' }),
  });
  const token = ((await res.json()) as { access_token: string }).access_token;
  const sub = fake.accounts.find((a) => a.code === code)?.sub ?? FAKE_SUB;
  return createPlayToolsHttpAdapter({
    tokens: { getAccessToken: async () => ({ value: token, expiresAt: new Date('2099-01-01T00:00:00Z'), subject: sub }) },
    connectionId: 1,
    baseUrl: fake.env.NUXT_POKEMON_API_URL,
  });
}

beforeEach(async () => {
  fake = await startFakePokemon();
  gateway = await login();
});
afterEach(() => fake.close());

const venueId = () => fake.venues[0]!.guid;
const newTournament = (overrides: Partial<NewTournament> = {}): NewTournament => ({
  groupId: GROUP,
  name: 'Tuesday League Challenge',
  product: 'tcg',
  category: 'tcg_std',
  seriesId: null,
  venueId: venueId(),
  startsAt: new Date('2026-10-20T23:00:00Z'),
  contact: { email: 'league@example.com', phone: null },
  ...overrides,
});

async function upstreamError(promise: Promise<unknown>): Promise<PokemonUpstreamError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PokemonUpstreamError);
  return err as PokemonUpstreamError;
}

describe('fake play-tools: the tournament lifecycle', () => {
  it('creates a tournament that reads back, lists, edits one field at a time and cancels', async () => {
    const { tournamentId } = await gateway.createTournament(newTournament({ details: 'Bring a deck' }));

    const created = await gateway.getTournament(tournamentId);
    expect(created).toMatchObject({
      name: 'Tuesday League Challenge',
      groupId: GROUP,
      startsAt: new Date('2026-10-20T23:00:00Z'),
      organizerPlayerId: ORGANIZER,
      applicationState: 'sanctioned',
      activityState: 'pending',
      category: 'tcg_std',
      details: 'Bring a deck',
      contact: { email: 'league@example.com', phone: null },
    });
    expect(created.displayId).toMatch(/^\d{2}-\d{2}-\d{6}$/);
    expect((await gateway.listTournaments()).map((t) => t.id)).toContain(tournamentId);

    await gateway.editTournament(tournamentId, { startsAt: new Date('2026-10-27T23:00:00Z') });
    const moved = await gateway.getTournament(tournamentId);
    expect(moved.startsAt).toEqual(new Date('2026-10-27T23:00:00Z'));
    expect(moved).toMatchObject({ details: 'Bring a deck', name: 'Tuesday League Challenge', category: 'tcg_std' });

    await gateway.cancelTournament(tournamentId);
    expect(await gateway.getTournament(tournamentId)).toMatchObject({ applicationState: 'cancelled', status: 'cancelled' });
    expect((await gateway.listTournaments()).map((t) => t.id)).not.toContain(tournamentId);
  });

  it('serves series, formats and venues for the professor', async () => {
    fake.series = [
      {
        guid: 'series-1',
        name: 'League Challenge',
        product: 'tcg',
        category_slugs: ['tcg_std'],
        tags: ['championship_series', 'league_challenge'],
        play_template: 'LEAGUECHALLENGE',
        schedule: { US: { start_date: '2026-11-01', end_date: '2026-11-30' } },
      },
    ];

    expect(await gateway.listSeries(GROUP)).toEqual([
      {
        id: 'series-1',
        name: 'League Challenge',
        product: 'tcg',
        categories: ['tcg_std'],
        tags: ['championship_series', 'league_challenge'],
        playTemplate: 'LEAGUECHALLENGE',
        windows: { US: { from: '2026-11-01', to: '2026-11-30' } },
      },
    ]);
    expect((await gateway.listFormats('US')).map((f) => f.product)).toEqual(['pgo', 'tcg', 'vg']);
    expect(await gateway.listVenues(GROUP, 'US')).toEqual([expect.objectContaining({ id: venueId(), timeZone: 'America/Chicago', country: 'US' })]);
  });

  it('refuses a create without division info as play-tools does (S8 recording 15)', async () => {
    const res = await fetch(`${fake.url}/services/core/tournament`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fake.liveAccessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', activity_division_info: null }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 'op.generic.bad_request',
      message: 'Invalid request.',
      errors: { activity_division_info: ['This field may not be null.'] },
    });
    expect(fake.tournaments).toHaveLength(0);
  });

  it('refuses a locked tournament with 423, another professor\'s with 403, and a scripted refusal once', async () => {
    fake.tournaments.push(fakeTournament('locked', { organizer: ORGANIZER }), fakeTournament('theirs', { organizer: '9999992' }));
    fake.lockedTournaments.add('locked');

    expect((await upstreamError(gateway.editTournament('locked', { details: 'x' }))).code).toBe('tournament_locked');
    expect((await upstreamError(gateway.cancelTournament('theirs'))).code).toBe('forbidden');

    fake.refuseOnce.set('/services/core/tournament', { status: 400, body: { code: 'op.generic.bad_request', message: 'Too far back.' } });
    const refused = await upstreamError(gateway.createTournament(newTournament()));
    expect(refused.code).toBe('refused');
    expect(refused.details.upstream).toEqual({ code: 'op.generic.bad_request', message: 'Too far back.', correlationId: expect.stringMatching(/^fake-/) });
    expect((await gateway.createTournament(newTournament())).tournamentId).toBeTruthy();
  });

  it('logs each write\'s body, so tests can see what was sent', async () => {
    fake.tournaments.push(fakeTournament('t-1', { organizer: ORGANIZER }));

    await gateway.editTournament('t-1', { details: 'Doors at 5' });

    expect(fake.requests.filter((r) => r.method === 'PATCH').map((r) => [r.path, r.body])).toEqual([
      ['/services/core/tournament/t-1/', { details: 'Doors at 5' }],
    ]);
  });
});

describe('fake play-tools: creates that may have landed (#92)', () => {
  it('answers 500 to a create that lands later: hidden from every read until land()', async () => {
    fake.createLandsLate = true;
    const err = await upstreamError(gateway.createTournament(newTournament()));
    expect(err.code).toBe('unavailable');
    expect(await gateway.listTournaments()).toEqual([]);
    expect(fake.createLandsLate).toBe(false);

    fake.land();
    const listed = await gateway.listTournaments();
    expect(listed.map((t) => t.name)).toEqual(['Tuesday League Challenge']);
    expect((await gateway.getTournament(listed[0]!.id)).category).toBe('tcg_std');
  });

  it('holds creates at a gate until released, logging each as it arrives', async () => {
    const gate = fake.holdCreates();
    const pending = gateway.createTournament(newTournament());
    await gate.arrived;
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path === '/services/core/tournament')).toHaveLength(1);
    expect(fake.tournaments).toEqual([]);
    gate.release();
    expect((await pending).tournamentId).toMatch(/^t-/);
  });
});

describe('fake play-tools: TDF results', () => {
  beforeEach(() => {
    fake.tournaments.push(fakeTournament('t-1', { organizer: ORGANIZER, displayId: '26-10-900001' }));
  });
  const displayId = () => fake.tournaments[0]!.display_id;

  it('validates, confirms, processes on cue and lists the upload, and never serves the file back', async () => {
    const { uploadId, errors } = await gateway.validateResults(displayId(), '<tournament/>');
    expect(errors).toEqual([]);
    expect((await gateway.listResultsUploads(displayId())).map((u) => [u.uploadId, u.accepted])).toEqual([[uploadId, false]]);

    await gateway.confirmResults(uploadId, 't-1');
    expect(await gateway.getTournament('t-1')).toMatchObject({ activityState: 'upload_in_progress' });

    fake.finishUpload('t-1', 'completed');
    expect(await gateway.getTournament('t-1')).toMatchObject({ activityState: 'completed', status: 'complete' });
    expect((await gateway.listResultsUploads(displayId())).map((u) => u.accepted)).toEqual([true]);

    const download = await fetch(`${fake.url}/services/triumph/tdf/${uploadId}`, { headers: { authorization: `Bearer ${fake.liveAccessToken()}` } });
    expect(download.status).toBe(403);
  });

  it('answers the scripted validation errors for a tournament, once', async () => {
    fake.tdfErrors.set(displayId(), [{ type: 'STAFF_PLAYERS_ERROR', message: '9999993' }]);

    const first = await gateway.validateResults(displayId(), '<tournament/>');
    expect(first.errors).toEqual([{ code: 'STAFF_PLAYERS_ERROR', message: expect.any(String), detail: '9999993' }]);
    expect((await gateway.validateResults(displayId(), '<tournament/>')).errors).toEqual([]);
    expect((await gateway.listResultsUploads(displayId()))[0]!.errors.map((e) => e.code)).toEqual(['STAFF_PLAYERS_ERROR']);
  });

  it('marks a failed upload when told to', async () => {
    const { uploadId } = await gateway.validateResults(displayId(), '<tournament/>');
    await gateway.confirmResults(uploadId, 't-1');

    fake.finishUpload('t-1', 'upload_failed');

    expect(await gateway.getTournament('t-1')).toMatchObject({ activityState: 'upload_failed', status: 'sanctioned' });
  });
});

describe('fake play-tools: other professors', () => {
  it('gives every account a user guid the address book and create accept', async () => {
    fake.addAccount({ playerId: '9999992', name: 'Second Prof', leagues: fake.leagues });
    const second = await login('code-9999992');

    expect(await second.listVenues(GROUP, 'US')).toHaveLength(1);
    const { tournamentId } = await second.createTournament(newTournament());
    expect((await second.getTournament(tournamentId)).organizerPlayerId).toBe('9999992');
  });
});
