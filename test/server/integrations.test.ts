import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AttendanceDayV1 } from '../../shared/schemas/integrations';
import { FAKE_PLAYER_ID, type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, logRecords, startServer } from './harness';

// #115: Tournament Genie reads a day's tournaments and staff with a bearer token (ADR-0013). The response is the
// v1 contract Genie builds against (the recorded fixture), and `professors` must never call a professor read
// when they weren't: Genie removes staff access only for a read organizer's missing tournament.

const OWNER = { username: 'organizer', password: 'correct horse' };
const ENV = { TZ: 'America/Chicago', NUXT_STAFF_DELAY_MS: '0', NUXT_LOG_FORMAT: 'json' };
const WED = '2026-10-14';
const BROCK = '0000222';
const FIXTURE = JSON.parse(readFileSync(new URL('./__fixtures__/integrations-v1-day.json', import.meta.url), 'utf8'));
const CHALLENGE = 'Bearer realm="integrations", error="invalid_token"';

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

const upstreamCalls = () => fake.requests.filter((r) => r.path.startsWith('/services/'));
const about = (tournamentId: string) =>
  fake.requests.filter((r) => r.path === `/services/core/tournament/${tournamentId}` || r.path.startsWith(`/services/core/tournaments/${tournamentId}/`));

describe('integrations API (#115)', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;
  /** Every response body read except the one-time create answers, for the secret sweep. */
  const bodies: string[] = [];
  /** Every secret minted in the test. */
  const secrets: string[] = [];

  async function start(env: Record<string, string> = {}) {
    server = await startServer({ env: { ...fake.env, ...ENV, ...env } });
    browser = client(server.url);
    const setup = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } });
    expect(setup.status).toBe(200);
  }

  async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
    const res = await browser.request(`/api${path}`, init);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, headers: res.headers, json: () => JSON.parse(text), text };
  }

  /** A request with no session cookie: how Genie calls. */
  async function genie(path: string, authorization?: string) {
    const res = await fetch(`${server.url}/api${path}`, { headers: authorization === undefined ? {} : { authorization } });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, headers: res.headers, json: () => JSON.parse(text), text };
  }

  /** Mints a token through Settings' route and returns its secret. */
  async function mint(label = 'Tournament Genie') {
    const res = await browser.request('/api/integrations/tokens', { method: 'POST', json: { label } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: { id: number }; secret: string };
    secrets.push(body.secret);
    return body;
  }

  const day = (secret: string, date = WED) => genie(`/integrations/v1/days/${date}`, `Bearer ${secret}`);

  async function connectAs(code: string) {
    const start = await api('/pokemon/connect/start', { method: 'POST', json: {} });
    const state = new URL((start.json() as { authorizeUrl: string }).authorizeUrl).searchParams.get('state');
    const res = await api('/pokemon/connect/complete', { method: 'POST', json: { url: `https://play-tools.pokemon.com/loggedIn?code=${code}&state=${state}` } });
    expect(res.status).toBe(200);
  }

  /** Olive (the default account, connected first) and Brock, both in the league. */
  async function twoProfessors(opts: { shortLived?: boolean } = {}) {
    if (opts.shortLived) fake.accessTtl = 60;
    await connectAs('fresh');
    const brock = fake.addAccount({ playerId: BROCK, name: 'Brock Harrison', leagues: fake.leagues });
    await connectAs(brock.code);
    expect((await api(`/pokemon/connections/${FAKE_PLAYER_ID}`, { method: 'PATCH', json: { name: 'Olive Oak' } })).status).toBe(200);
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

  beforeEach(() => {
    fake.requests.length = 0;
    fake.accessTtl = 3599;
    fake.accounts.splice(1);
    fake.failOnce.clear();
    fake.lockedTournaments = new Set();
    fake.leagues = [{ guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true }];
    fake.tournaments = [
      // 18:30 and 17:00 on Wednesday in Chicago.
      fakeTournament('olives', { startsAt: '2026-10-14T23:30:00Z', organizer: FAKE_PLAYER_ID, name: 'Olive Cup', displayId: '26-10-000001' }),
      fakeTournament('brocks', { startsAt: '2026-10-14T22:00:00Z', organizer: BROCK, name: 'Brock Cup', displayId: '26-10-000002', product: 'vg' }),
      fakeTournament('brocks-elsewhere', { startsAt: '2026-10-14T21:00:00Z', organizer: BROCK, groupId: 'another-store' }),
    ];
    fake.tournamentRecords = new Map([
      ['olives', [fakeRecord(FAKE_PLAYER_ID, { role: 'organizer' }), fakeRecord('00555', { role: 'judge', first: 'Jo', last: 'Judge' })]],
      ['brocks', [fakeRecord(BROCK, { role: 'organizer' })]],
      ['brocks-elsewhere', [fakeRecord(BROCK, { role: 'organizer' })]],
    ]);
    bodies.length = 0;
    secrets.length = 0;
  });

  afterEach(async () => {
    const logs = server.logs();
    for (const text of [...bodies, logs]) {
      for (const s of [...secrets, ...fake.issuedTokens()]) expect(text).not.toContain(s);
    }
    await server.dispose();
  });

  describe('GET /integrations/v1/days/{date}', () => {
    it('answers the recorded v1 fixture: both professors read, tournaments by start, live staff only, read with GETs alone', async () => {
      await start();
      await twoProfessors();
      // An applied scorekeeper, then a pending judge, on Olive Cup. Jo Judge is in play-tools only.
      expect((await api(`/sessions/${WED}/staff`, { method: 'POST', json: { tournamentId: 'olives', playerId: '00888', role: 'scorekeeper', name: 'Misty Waterflower' } })).status).toBe(201);
      const applied = await api(`/sessions/${WED}/staff/apply`, { method: 'POST', json: { tournamentId: 'olives' } });
      expect(applied.status).toBe(202);
      expect((await finished(applied.json().submissionId)).status).toBe('succeeded');
      expect((await api(`/sessions/${WED}/staff`, { method: 'POST', json: { tournamentId: 'olives', playerId: '00777', role: 'judge', name: 'Ash Ketchum' } })).status).toBe(201);
      const { secret } = await mint();
      const cardBefore = (await api(`/sessions/${WED}/staff`)).json();
      fake.requests.length = 0;

      const res = await day(secret);

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.json()).toEqual(FIXTURE);
      expect(AttendanceDayV1.parse(res.json())).toEqual(FIXTURE);

      // Read-only, and no more traffic than the staff card: one listing per professor, two reads per tournament.
      expect(upstreamCalls().every((r) => r.method === 'GET')).toBe(true);
      expect(fake.requests.filter((r) => r.path === '/services/core/activities')).toHaveLength(2);
      expect(about('olives').map((r) => r.as)).toEqual([FAKE_PLAYER_ID, FAKE_PLAYER_ID]);
      expect(about('brocks').map((r) => r.as)).toEqual([BROCK, BROCK]);
      expect(about('brocks-elsewhere')).toEqual([]);
      expect((await api(`/sessions/${WED}/staff`)).json().tournaments.map((t: { assignments: unknown }) => t.assignments)).toEqual(
        cardBefore.tournaments.map((t: { assignments: unknown }) => t.assignments),
      );

      await server.waitForLog(/"msg":"integration day read"/);
      const audit = logRecords(server.logs()).filter((r) => r.msg === 'integration day read');
      expect(audit).toEqual([expect.objectContaining({ tokenLabel: 'Tournament Genie', date: WED, tournaments: 2, unread: [] })]);
    });

    it("leaves out tombstoned assignments and play-tools-only staff, and keeps a tournament that ends the date late in the league's day", async () => {
      await start();
      await twoProfessors();
      // 23:30 in Chicago is already Thursday in UTC; midnight in Chicago is Thursday.
      fake.tournaments.push(
        fakeTournament('late', { startsAt: '2026-10-15T04:30:00Z', organizer: FAKE_PLAYER_ID, name: 'Late Cup' }),
        fakeTournament('thursday', { startsAt: '2026-10-15T05:00:00Z', organizer: FAKE_PLAYER_ID }),
      );
      fake.tournamentRecords.set('late', [fakeRecord(FAKE_PLAYER_ID, { role: 'organizer' })]);
      const added = await api(`/sessions/${WED}/staff`, { method: 'POST', json: { tournamentId: 'olives', playerId: '00777', role: 'judge', name: 'Ash Ketchum' } });
      expect((await api(`/sessions/${WED}/staff/${added.json().assignment.id}`, { method: 'DELETE' })).status).toBe(204);
      const { secret } = await mint();

      const body = (await day(secret)).json();
      expect(body.tournaments.map((t: { id: string }) => t.id)).toEqual(['brocks', 'olives', 'late']);
      expect(body.tournaments.find((t: { id: string }) => t.id === 'olives').staff).toEqual([]);
    });

    it("reports a professor whose login is refused as unread needs_reconnect, drops their tournaments, and calls nothing as them once they need a reconnect", async () => {
      await start();
      await twoProfessors({ shortLived: true });
      const { secret } = await mint();
      fake.revokeChain(BROCK);

      const first = (await day(secret)).json();
      expect(first.tournaments.map((t: { id: string }) => t.id)).toEqual(['olives']);
      expect(first.professors).toEqual([
        { playerId: FAKE_PLAYER_ID, name: 'Olive Oak', status: 'read' },
        { playerId: BROCK, name: 'Brock Harrison', status: 'unread', reason: 'needs_reconnect' },
      ]);

      fake.requests.length = 0;
      const second = (await day(secret)).json();
      expect(second.professors[1]).toEqual({ playerId: BROCK, name: 'Brock Harrison', status: 'unread', reason: 'needs_reconnect' });
      expect(fake.requests.filter((r) => r.as === BROCK)).toEqual([]);
    });

    it("reports a professor play-tools fails for partway as unread read_failed, with none of their tournaments, and everyone else's", async () => {
      await start();
      await twoProfessors();
      const { secret } = await mint();
      fake.failOnce.set(`/services/core/tournament/brocks@${BROCK}`, 503);

      const body = (await day(secret)).json();
      expect(body.tournaments.map((t: { id: string }) => t.id)).toEqual(['olives']);
      expect(body.professors).toEqual([
        { playerId: FAKE_PLAYER_ID, name: 'Olive Oak', status: 'read' },
        { playerId: BROCK, name: 'Brock Harrison', status: 'unread', reason: 'read_failed' },
      ]);
    });

    it('answers an empty day with no professors, calling nothing upstream, before any professor is connected', async () => {
      await start();
      const { secret } = await mint();
      const res = await day(secret);
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ date: WED, timezone: 'America/Chicago', tournaments: [], professors: [] });
      expect(upstreamCalls()).toEqual([]);
    });

    it('is 409 league_not_selected when professors are connected but no league is chosen', async () => {
      fake.leagues.push({ guid: 'group-2', display_id: 'L7000', display_name: 'Game Den', canSubmit: true });
      await start();
      await connectAs('fresh');
      const { secret } = await mint();
      const res = await day(secret);
      expect(res.status).toBe(409);
      expect(res.json().data).toEqual({ code: 'league_not_selected' });
    });

    it.each(['2026-02-30', '20261014', '2026-10-1'])('is 400 for the date %s, calling nothing upstream', async (date) => {
      await start();
      await twoProfessors();
      const { secret } = await mint();
      const res = await day(secret, date);
      expect(res.status).toBe(400);
      expect(upstreamCalls()).toEqual([]);
    });
  });

  describe('authentication', () => {
    it('answers every missing, malformed, unknown or revoked token with the same 401 and challenge, and takes the scheme in any case', async () => {
      await start();
      const { secret, token } = await mint();
      const revoked = await mint('Revoked');
      expect((await api(`/integrations/tokens/${revoked.token.id}`, { method: 'DELETE' })).status).toBe(204);

      const refusals = await Promise.all(
        [undefined, `Basic ${secret}`, 'Bearer', `Bearer ppa_int_${'A'.repeat(43)}`, `Bearer ${revoked.secret}`, `Bearer ${secret} ${secret}`].map((h) =>
          genie(`/integrations/v1/days/${WED}`, h),
        ),
      );
      for (const res of refusals) {
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
        expect(res.json().data).toEqual({ code: 'invalid_token' });
        expect(res.text).toBe(refusals[0]!.text);
      }

      expect((await genie(`/integrations/v1/days/${WED}`, `bearer ${secret}`)).status).toBe(200);
      expect(token.id).toBeGreaterThan(0);
    });

    it("refuses the organizer's session cookie alone: only a bearer token reads the day", async () => {
      await start();
      const res = await api(`/integrations/v1/days/${WED}`);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    });

    it.each(['/settings', '/integrations/tokens', `/sessions/${WED}/staff`, '/pokemon/connections'])('gives a bearer token no access to %s', async (path) => {
      await start();
      const { secret } = await mint();
      expect((await genie(path, `Bearer ${secret}`)).status).toBe(401);
    });

    it('marks a token used on a successful read', async () => {
      await start();
      const { secret } = await mint();
      expect((await api('/integrations/tokens')).json().tokens[0].lastUsedAt).toBeNull();
      expect((await day(secret)).status).toBe(200);
      expect((await api('/integrations/tokens')).json().tokens[0].lastUsedAt).toEqual(expect.any(String));
    });

    it('limits each token, refusing with 429 and Retry-After before reading upstream, while another token is still served', async () => {
      await start({ NUXT_INTEGRATION_RATE_LIMIT_MAX: '2' });
      await twoProfessors();
      const busy = await mint('Busy');
      const other = await mint('Other');
      expect((await day(busy.secret)).status).toBe(200);
      expect((await day(busy.secret)).status).toBe(200);
      fake.requests.length = 0;

      const limited = await day(busy.secret);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(limited.json().data).toMatchObject({ code: 'rate_limited' });
      expect(upstreamCalls()).toEqual([]);
      expect((await day(other.secret)).status).toBe(200);
    });
  });

  describe('token routes (Settings)', () => {
    it('mints a token whose secret is shown only in the create answer and lists it by hint', async () => {
      await start();
      const res = await browser.request('/api/integrations/tokens', { method: 'POST', json: { label: 'Tournament Genie' } });
      expect(res.status).toBe(201);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const { token, secret } = (await res.json()) as { token: Record<string, unknown>; secret: string };
      secrets.push(secret);
      expect(secret).toMatch(/^ppa_int_[A-Za-z0-9_-]{43}$/);
      expect(token).toEqual({
        id: expect.any(Number),
        label: 'Tournament Genie',
        hint: `ppa_int_…${secret.slice(-4)}`,
        createdBy: 'organizer',
        createdAt: expect.any(String),
        lastUsedAt: null,
      });

      const list = await api('/integrations/tokens');
      expect(list.status).toBe(200);
      expect(list.headers.get('cache-control')).toBe('no-store');
      expect(list.json()).toEqual({ tokens: [token] });
    });

    it.each([
      ['an empty body', {}],
      ['an empty label', { label: '' }],
      ['a blank label', { label: '   ' }],
      ['a 61-character label', { label: 'x'.repeat(61) }],
      ['a number', { label: 5 }],
      ['null', null],
    ])('is 400 for %s', async (_l, json) => {
      await start();
      expect((await api('/integrations/tokens', { method: 'POST', json })).status).toBe(400);
      expect((await api('/integrations/tokens')).json().tokens).toEqual([]);
    });

    it('takes a 60-character label', async () => {
      await start();
      expect((await mint('x'.repeat(60))).token).toMatchObject({ label: 'x'.repeat(60) });
    });

    it('refuses an eleventh token with 409 token_limit', async () => {
      await start();
      for (let i = 0; i < 10; i++) await mint(`Token ${i}`);
      const res = await api('/integrations/tokens', { method: 'POST', json: { label: 'One too many' } });
      expect(res.status).toBe(409);
      expect(res.json().data).toEqual({ code: 'token_limit' });
      expect((await api('/integrations/tokens')).json().tokens).toHaveLength(10);
    });

    it('revokes a token: 204, gone from the list, its secret refused, and 404 not_found after', async () => {
      await start();
      const { token, secret } = await mint();
      expect((await day(secret)).status).toBe(200);
      expect((await api(`/integrations/tokens/${token.id}`, { method: 'DELETE' })).status).toBe(204);
      expect((await api('/integrations/tokens')).json().tokens).toEqual([]);
      expect((await day(secret)).status).toBe(401);
      const again = await api(`/integrations/tokens/${token.id}`, { method: 'DELETE' });
      expect(again.status).toBe(404);
      expect(again.json().data).toEqual({ code: 'not_found' });
      expect((await api('/integrations/tokens/abc', { method: 'DELETE' })).status).toBe(400);
    });

    it('requires the organizer to be logged in on every token route', async () => {
      await start();
      const anonymous = client(server.url);
      for (const [method, path] of [
        ['GET', '/api/integrations/tokens'],
        ['POST', '/api/integrations/tokens'],
        ['DELETE', '/api/integrations/tokens/1'],
      ] as const) {
        const res = await anonymous.request(path, { method, ...(method === 'POST' ? { json: { label: 'x' } } : {}) });
        expect(res.status).toBe(401);
      }
    });
  });
});
