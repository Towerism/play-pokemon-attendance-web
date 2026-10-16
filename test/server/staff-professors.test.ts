import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PLAYER_ID, type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, startServer } from './harness';

// #75: This week reads every connected professor's tournaments, and each
// tournament is read and staffed only as its organizer. The fake follows S6:
// play-tools lists only the caller's own tournaments, and only the organizer
// reads or writes a tournament's records.

const OWNER = { username: 'organizer', password: 'correct horse' };
const ENV = { TZ: 'America/Chicago', NUXT_STAFF_DELAY_MS: '0' };
const WED = '2026-10-14';
const BROCK = '0000222';
const CILAN = '0000333';

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

/** Every play-tools request about one tournament: its details, records and staff writes. */
const about = (tournamentId: string) =>
  fake.requests.filter((r) => r.path === `/services/core/tournament/${tournamentId}` || r.path.startsWith(`/services/core/tournaments/${tournamentId}/`));
const listings = () => fake.requests.filter((r) => r.path === '/services/core/activities');

describe('staff across connected professors (#75)', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;
  /** Every response body read, for the secret sweep. */
  const bodies: string[] = [];

  async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
    const res = await browser.request(`/api${path}`, init);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, json: () => JSON.parse(text) };
  }

  async function connectAs(code: string) {
    const start = await api('/pokemon/connect/start', { method: 'POST', json: {} });
    const state = new URL((start.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get('state');
    const res = await api('/pokemon/connect/complete', { method: 'POST', json: { url: `https://play-tools.pokemon.com/loggedIn?code=${code}&state=${state}` } });
    expect(res.status).toBe(200);
  }

  /** Olive (the default account) submits; Brock is connected too, in the same league. */
  async function twoProfessors(opts: { shortLived?: boolean } = {}) {
    // Short-lived access tokens make every use refresh, so a revoked chain is noticed on the next call.
    if (opts.shortLived) fake.accessTtl = 60;
    await connectAs('fresh');
    const brock = fake.addAccount({ playerId: BROCK, name: 'Brock Harrison', leagues: fake.leagues });
    await connectAs(brock.code);
    expect((await api(`/pokemon/connections/${BROCK}`, { method: 'PATCH', json: { name: 'Brock Harrison' } })).status).toBe(200);
    fake.requests.length = 0;
  }

  async function finished(submissionId: number) {
    for (let i = 0; i < 200; i++) {
      const view = (await api(`/submissions/${submissionId}`)).json();
      if (!['planned', 'running'].includes(view.status)) return view;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the job did not finish');
  }

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.accessTtl = 3599;
    fake.accounts.splice(1);
    fake.failOnce.clear();
    fake.lockedTournaments = new Set();
    fake.leagues = [{ guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true }];
    fake.tournaments = [
      // 18:30 and 17:00 on Wednesday in Chicago.
      fakeTournament('olives', { startsAt: '2026-10-14T23:30:00Z', organizer: FAKE_PLAYER_ID, name: 'Olive Cup' }),
      fakeTournament('brocks', { startsAt: '2026-10-14T22:00:00Z', organizer: BROCK, name: 'Brock Cup' }),
      fakeTournament('brocks-elsewhere', { startsAt: '2026-10-14T21:00:00Z', organizer: BROCK, groupId: 'another-store' }),
    ];
    fake.tournamentRecords = new Map([
      ['olives', [fakeRecord(FAKE_PLAYER_ID, { role: 'organizer' }), fakeRecord('00555', { role: 'judge', first: 'Jo', last: 'Judge' })]],
      ['brocks', [fakeRecord(BROCK, { role: 'organizer' }), fakeRecord('00666', { role: 'scorekeeper', first: 'Sam', last: 'Score' })]],
      ['brocks-elsewhere', [fakeRecord(BROCK, { role: 'organizer' })]],
    ]);
    bodies.length = 0;
    server = await startServer({ env: { ...fake.env, ...ENV } });
    browser = client(server.url);
    const setup = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } });
    expect(setup.status).toBe(200);
  });

  afterEach(async () => {
    const secrets = fake.issuedTokens();
    for (const text of [...bodies, server.logs()]) for (const s of secrets) expect(text).not.toContain(s);
    expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
    await server.dispose();
  });

  describe('GET /sessions/{date}/staff', () => {
    it("shows every professor's tournaments in this league by start, each read only as its organizer, each listing and tournament read once", async () => {
      await twoProfessors();

      const res = await api(`/sessions/${WED}/staff`);
      expect(res.status).toBe(200);
      const view = res.json();
      expect(view.unread).toEqual([]);
      expect(view.tournaments.map((t: { tournamentId: string; organizer: unknown; editable: boolean }) => [t.tournamentId, t.organizer, t.editable])).toEqual([
        ['brocks', { playerId: BROCK, name: 'Brock Harrison', connected: true, needsReconnect: false }, true],
        ['olives', { playerId: FAKE_PLAYER_ID, name: null, connected: true, needsReconnect: false }, true],
      ]);

      expect(about('olives').map((r) => r.as)).toEqual([FAKE_PLAYER_ID, FAKE_PLAYER_ID]);
      expect(about('brocks').map((r) => r.as)).toEqual([BROCK, BROCK]);
      expect(about('brocks-elsewhere')).toEqual([]);
      expect(listings().map((r) => r.as).sort()).toEqual([BROCK, FAKE_PLAYER_ID].sort());

      // Brock's staff joins the staff list, like anyone's.
      expect((await api('/staff')).json().map((s: { playerId: string }) => s.playerId).sort()).toEqual(['00555', '00666']);
    });

    it("still shows everyone else's tournaments when the submitting professor's login is refused, naming them", async () => {
      await twoProfessors({ shortLived: true });
      fake.revokeChain(FAKE_PLAYER_ID);

      const res = await api(`/sessions/${WED}/staff`);
      expect(res.status).toBe(200);
      const view = res.json();
      expect(view.tournaments.map((t: { tournamentId: string }) => t.tournamentId)).toEqual(['brocks']);
      expect(view.unread).toEqual([{ professor: { playerId: FAKE_PLAYER_ID, name: null }, code: 'needs_reconnect', message: expect.any(String) }]);
      expect(fake.requests.filter((r) => r.path.startsWith('/services/') && r.as === FAKE_PLAYER_ID)).toEqual([]);
    });

    it("isolates a professor play-tools fails for: the others show, and nothing of theirs goes through another login", async () => {
      await twoProfessors();
      fake.failOnce.set(`/services/core/activities@${BROCK}`, 503);

      const res = await api(`/sessions/${WED}/staff`);
      expect(res.status).toBe(200);
      const view = res.json();
      expect(view.tournaments.map((t: { tournamentId: string }) => t.tournamentId)).toEqual(['olives']);
      expect(view.unread).toEqual([{ professor: { playerId: BROCK, name: 'Brock Harrison' }, code: 'unavailable', message: expect.any(String) }]);
      expect(about('brocks').filter((r) => r.as !== BROCK)).toEqual([]);
    });

    it('answers 409 not_connected before any professor is connected', async () => {
      const res = await api(`/sessions/${WED}/staff`);
      expect(res.status).toBe(409);
      expect(res.json().data).toEqual({ code: 'not_connected' });
    });

    it('lists each professor once and reads each tournament once with 3 professors and 4 tournaments, in under 1 s at p95 over 5 loads', async () => {
      await twoProfessors();
      const cilan = fake.addAccount({ playerId: CILAN, name: 'Cilan', leagues: fake.leagues });
      await connectAs(cilan.code);
      for (const n of [1, 2]) {
        fake.tournaments.push(fakeTournament(`cilans-${n}`, { startsAt: `2026-10-14T1${6 + n}:00:00Z`, organizer: CILAN }));
        fake.tournamentRecords.set(`cilans-${n}`, [fakeRecord(CILAN, { role: 'organizer' })]);
      }
      fake.requests.length = 0;

      const ms: number[] = [];
      for (let i = 0; i < 5; i++) {
        const began = performance.now();
        expect((await api(`/sessions/${WED}/staff`)).json().tournaments).toHaveLength(4);
        ms.push(performance.now() - began);
        if (i === 0) {
          expect(listings()).toHaveLength(3);
          for (const t of ['olives', 'brocks', 'cilans-1', 'cilans-2']) expect(about(t)).toHaveLength(2);
        }
      }
      expect(ms.sort((a, b) => a - b)[4]).toBeLessThan(1000);
    });
  });

  describe('logging staff as the organizer', () => {
    it("adds and applies staff on another professor's tournament as them, and History says so", async () => {
      await twoProfessors();
      const add = await api(`/sessions/${WED}/staff`, { method: 'POST', json: { tournamentId: 'brocks', playerId: '00999', role: 'judge', name: 'New Judge' } });
      expect(add.status).toBe(201);

      const apply = await api(`/sessions/${WED}/staff/apply`, { method: 'POST', json: { tournamentId: 'brocks' } });
      expect(apply.status).toBe(202);
      const view = await finished(apply.json().submissionId);

      expect(view).toMatchObject({ status: 'succeeded', professor: { playerId: BROCK, name: 'Brock Harrison' } });
      expect(fake.tournamentRecords.get('brocks')!.map((r) => r.participant.player_id)).toContain('00999');
      expect(about('brocks').length).toBeGreaterThan(0);
      expect(about('brocks').filter((r) => r.as !== BROCK)).toEqual([]);
    });

    it("refuses 409 organizer_not_connected for a tournament whose organizer isn't connected, storing nothing", async () => {
      await twoProfessors();
      fake.tournaments.push(fakeTournament('cilans', { startsAt: '2026-10-14T20:00:00Z', organizer: CILAN }));

      const res = await api(`/sessions/${WED}/staff`, { method: 'POST', json: { tournamentId: 'cilans', playerId: '00999', role: 'judge' } });
      expect(res.status).toBe(409);
      expect(res.json().data).toEqual({ code: 'organizer_not_connected', organizerPlayerId: CILAN });
      expect((await api(`/sessions/${WED}/staff`)).json().tournaments.map((t: { tournamentId: string }) => t.tournamentId)).not.toContain('cilans');
    });

    it("refuses 409 needs_reconnect naming the organizer when their login is refused, starting no job", async () => {
      await twoProfessors({ shortLived: true });
      expect((await api(`/sessions/${WED}/staff`, { method: 'POST', json: { tournamentId: 'brocks', playerId: '00999', role: 'judge' } })).status).toBe(201);
      fake.revokeChain(BROCK);

      const res = await api(`/sessions/${WED}/staff/apply`, { method: 'POST', json: { tournamentId: 'brocks' } });
      expect(res.status).toBe(409);
      expect(res.json().data).toEqual({ code: 'needs_reconnect', professorPlayerId: BROCK });
      expect((await api('/submissions')).json().submissions.filter((s: { kind: string }) => s.kind === 'staff')).toEqual([]);
      expect(about('brocks').filter((r) => r.as !== BROCK && r.path.startsWith('/services/core/tournaments/'))).toEqual([]);
    });
  });

  describe('POST /staff/import', () => {
    it("imports every professor's staff, each read as its organizer, and records no single professor", async () => {
      await twoProfessors();

      const res = await api('/staff/import', { method: 'POST' });
      expect(res.status).toBe(202);
      const view = await finished(res.json().submissionId);

      expect(view).toMatchObject({ status: 'succeeded', professor: null });
      expect((await api('/staff')).json().map((s: { playerId: string }) => s.playerId).sort()).toEqual(['00555', '00666']);
      for (const [t, as] of [
        ['olives', FAKE_PLAYER_ID],
        ['brocks', BROCK],
      ]) {
        expect(about(t!).filter((r) => r.as !== as)).toEqual([]);
      }
    });
  });
});
