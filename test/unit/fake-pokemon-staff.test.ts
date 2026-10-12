import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlayToolsHttpAdapter } from '../../server/modules/pokemon/adapters/play-tools/gateway';
import { PokemonUpstreamError } from '../../server/modules/pokemon/ports/errors';
import type { PlayToolsGateway } from '../../server/modules/pokemon/ports/play-tools-gateway';
import type { PlayerId } from '../../shared/types/ids';
import { type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from '../server/fake-pokemon';

// The fake's tournaments and staff (S6), driven through the real play-tools
// adapter, so the server and E2E tests for M8 exercise the recorded contract.

const T = 'tournament-1';
const ORGANIZER = '9999991';
const pid = (s: string) => s as PlayerId;

let fake: FakePokemon;
let gateway: PlayToolsGateway;

beforeEach(async () => {
  fake = await startFakePokemon();
  const res = await fetch(`${fake.url}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'op-tools-app', code: 'c', code_verifier: 'v' }),
  });
  const token = ((await res.json()) as { access_token: string }).access_token;
  gateway = createPlayToolsHttpAdapter({
    tokens: { getAccessToken: async () => ({ value: token, expiresAt: new Date(Date.now() + 3_600_000), subject: 'sub' }) },
    leagueId: 'default',
    baseUrl: fake.env.NUXT_POKEMON_API_URL,
  });
  fake.tournaments.push(fakeTournament(T, { startsAt: '2026-10-11T19:30:00Z', organizer: ORGANIZER }));
  fake.tournamentRecords.set(T, [fakeRecord(ORGANIZER, { role: 'organizer' }), fakeRecord('1111')]);
});
afterEach(() => fake.close());

describe('fake play-tools: tournaments and staff', () => {
  it('lists the organizer\'s tournaments newest first, ignoring date filters and paging by page_size', async () => {
    for (let i = 1; i <= 45; i++) {
      fake.tournaments.push(fakeTournament(`old-${i}`, { startsAt: new Date(Date.parse('2026-09-01T18:00:00Z') - i * 86_400_000).toISOString() }));
    }
    fake.tournaments.push(fakeTournament('other-store', { startsAt: '2026-10-11T15:00:00Z', groupId: 'group-2' }));

    const today = await gateway.listTournaments({ from: new Date('2026-10-11T05:00:00Z'), to: new Date('2026-10-12T05:00:00Z') });
    expect(today.map((t) => [t.id, t.groupId])).toEqual([
      ['other-store', 'group-2'],
      [T, 'group-1'],
    ]);

    const all = await gateway.listTournaments();
    expect(all).toHaveLength(47);
    const pages = fake.requests.filter((r) => r.path === '/services/core/activities');
    expect(pages.length).toBeGreaterThan(2);
  });

  it('serves details with the organizer and every participant unfiltered', async () => {
    expect((await gateway.getTournament(T)).organizerPlayerId).toBe(ORGANIZER);
    expect((await gateway.listTournamentParticipants(T)).map((p) => [p.playerId, p.role, p.isStaff])).toEqual([
      [ORGANIZER, 'organizer', true],
      ['1111', null, false],
    ]);
    await expect(gateway.getTournament('missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('assigns, refuses a duplicate in any role, changes the role and removes, recording each body', async () => {
    const assigned = await gateway.assignStaff(T, { playerId: pid('2222'), role: 'judge' });
    expect(assigned).toEqual({ status: 'assigned', recordId: expect.any(String) });
    const recordId = (assigned as { recordId: string }).recordId;

    expect(await gateway.assignStaff(T, { playerId: pid('2222'), role: 'scorekeeper' })).toEqual({
      status: 'refused',
      code: 'cannot_duplicate_participant',
    });
    expect(await gateway.assignStaff(T, { playerId: pid('1111'), role: 'judge' })).toEqual({
      status: 'refused',
      code: 'cannot_duplicate_participant',
    });
    expect(await gateway.changeStaffRole(T, recordId, 'administration')).toBe('changed');
    expect((await gateway.listTournamentParticipants(T)).find((p) => p.playerId === '2222')?.role).toBe('administration');
    expect(await gateway.unassignStaff(T, recordId, pid('2222'))).toBe('removed');
    expect(await gateway.unassignStaff(T, recordId, pid('2222'))).toBe('not_found');
    expect(await gateway.changeStaffRole(T, recordId, 'judge')).toBe('not_found');

    const writes = fake.requests.filter((r) => r.method !== 'GET' && r.path.startsWith(`/services/core/tournaments/${T}/`));
    expect(writes.map((r) => [r.method, r.body])).toEqual([
      ['POST', { role: 'judge', player: false, participant: { player_id: '2222' }, origin: 'manual' }],
      ['POST', { role: 'scorekeeper', player: false, participant: { player_id: '2222' }, origin: 'manual' }],
      ['POST', { role: 'judge', player: false, participant: { player_id: '1111' }, origin: 'manual' }],
      ['PATCH', [{ op: 'replace', path: '/role', value: 'administration' }]],
      ['DELETE', [{ legacy_alias: '2222' }]],
      ['DELETE', [{ legacy_alias: '2222' }]],
      ['PATCH', [{ op: 'replace', path: '/role', value: 'judge' }]],
    ]);
  });

  it('refuses a staffer upstream would turn away, with the code it is told to use', async () => {
    fake.refuseStaff.set('3333', 'op.activity_record.missing_certification');
    expect(await gateway.assignStaff(T, { playerId: pid('3333'), role: 'judge' })).toEqual({ status: 'refused', code: 'missing_certification' });
    expect((await gateway.listTournamentParticipants(T)).map((p) => p.playerId)).not.toContain('3333');
  });

  it('locks every write to a tournament past its window with 423', async () => {
    const assigned = (await gateway.assignStaff(T, { playerId: pid('2222'), role: 'judge' })) as { recordId: string };
    fake.lockedTournaments.add(T);

    for (const write of [
      () => gateway.assignStaff(T, { playerId: pid('4444'), role: 'judge' }),
      () => gateway.changeStaffRole(T, assigned.recordId, 'scorekeeper'),
      () => gateway.unassignStaff(T, assigned.recordId, pid('2222')),
    ]) {
      const err = await write().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PokemonUpstreamError);
      expect((err as PokemonUpstreamError).code).toBe('tournament_locked');
    }
    expect((await gateway.listTournamentParticipants(T)).map((p) => [p.playerId, p.role])).toContainEqual(['2222', 'judge']);
  });
});

describe('fake play-tools: slow tournament reads', () => {
  it("holds each read of a tournament's records for tournamentReadDelayMs (to keep an import running)", async () => {
    fake.tournamentReadDelayMs = 150;

    const began = Date.now();
    const everyone = await gateway.listTournamentParticipants(T);

    expect(Date.now() - began).toBeGreaterThanOrEqual(140);
    expect(everyone.map((p) => p.playerId)).toEqual([ORGANIZER, '1111']);
  });
});

describe('fake play-tools: failing once', () => {
  it('answers the next request for a path with the given status, then serves it normally', async () => {
    fake.failOnce.set(`/services/core/tournament/${T}`, 503);
    await expect(gateway.getTournament(T)).rejects.toEqual(expect.objectContaining({ code: 'unavailable' }));
    await expect(gateway.getTournament(T)).resolves.toMatchObject({ id: T });
  });
});
