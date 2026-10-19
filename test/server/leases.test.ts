import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tomTdf } from '../../shared/tdf/__fixtures__/tom';
import { localInstant } from '../../shared/time/local-time';
import { FAKE_PLAYER_ID, type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, startServer } from './harness';
import { leagueDay } from './league-day';

// Tournament leases (ADR-0015 §5) over HTTP against the real server: the owner lends a tournament to a member
// professor, who then staffs it through the owner's connection until the lease ends.

const OWNER = { username: 'organizer', password: 'correct horse' };
const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };
const ELSEWHERE = { guid: 'group-2', display_id: 'L7000', display_name: 'Game Den', canSubmit: true };
const ZONE = 'America/Chicago';
const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const T2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const DAY = 86_400_000;

type Browser = ReturnType<typeof client>;

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const codeOf = async (res: Response) => (await json<{ data?: { code?: string } }>(res)).data?.code;
/** The league's calendar date of an instant. */
const dateOf = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

async function connect(browser: Browser, code = 'fresh') {
  const start = await browser.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL((await json<{ authorizeUrl: string }>(start)).authorizeUrl).searchParams.get('state');
  return browser.request('/api/pokemon/connect/complete', { method: 'POST', json: { url: `https://play-tools.pokemon.com/loggedIn?code=${code}&state=${state}` } });
}

describe('tournament leases', () => {
  let server: TestServer;
  let owner: Browser;
  let db: Database.Database;
  /** Three days ahead, so the lease window is open whatever today is. */
  const startsAt = new Date(Date.now() + 3 * DAY);
  const date = dateOf(startsAt);

  /** A professor who joined through an invite and connected `playerId` in `leagues`. */
  async function professor(username: string, playerId: string, leagues = [CARD_SHOP]) {
    const { secret } = await json<{ secret: string }>(await owner.request('/api/professors/invites', { method: 'POST', json: { send: 'copy' } }));
    const browser = client(server.url);
    expect((await browser.request('/api/invites/accept', { method: 'POST', json: { secret, username, password: 'water types' } })).status).toBe(201);
    const account = fake.addAccount({ playerId, name: username, leagues });
    expect((await connect(browser, account.code)).status).toBe(200);
    const userId = (db.prepare('select id from app_user where username = ?').get(username) as { id: number }).id;
    return { browser, userId };
  }

  async function lend(tournamentIds: string[], lesseeUserId: number, as = owner, extra: Record<string, unknown> = {}) {
    return as.request('/api/tournament-leases', { method: 'POST', json: { tournamentIds, lesseeUserId, ...extra } });
  }

  async function finished(browser: Browser, submissionId: number) {
    for (let i = 0; i < 200; i++) {
      const view = await json<{ status: string }>(await browser.request(`/api/submissions/${submissionId}`));
      if (!['planned', 'running'].includes(view.status)) return view as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the job did not finish');
  }

  const addStaffer = (browser: Browser, playerId: string, tournamentId = T1) =>
    browser.request(`/api/sessions/${date}/staff`, { method: 'POST', json: { tournamentId, playerId, role: 'judge', name: `Staffer ${playerId}` } });

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.accounts.splice(1);
    fake.leagues = [CARD_SHOP];
    fake.tournaments = [
      fakeTournament(T1, { startsAt: startsAt.toISOString(), organizer: FAKE_PLAYER_ID, name: 'Olive Cup' }),
      fakeTournament(T2, { startsAt: new Date(startsAt.getTime() + 3_600_000).toISOString(), organizer: FAKE_PLAYER_ID, name: 'Olive Challenge' }),
    ];
    fake.tournamentRecords = new Map([
      [T1, [fakeRecord(FAKE_PLAYER_ID, { role: 'organizer' })]],
      [T2, [fakeRecord(FAKE_PLAYER_ID, { role: 'organizer' })]],
    ]);
    server = await startServer({ env: { ...fake.env, TZ: ZONE, NUXT_STAFF_DELAY_MS: '0', NUXT_INVITE_RATE_LIMIT_MAX: '1000' } });
    owner = client(server.url);
    expect((await owner.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } })).status).toBe(200);
    expect((await connect(owner)).status).toBe(200);
    db = new Database(join(server.dataDir, 'app.db'));
    db.pragma('busy_timeout = 5000');
  });
  afterEach(async () => {
    db.close();
    await server.dispose();
  });

  it('lends a tournament to a member professor, listing it for the owner and them, but not for anyone else', async () => {
    const misty = await professor('misty', '0000333');
    const brock = await professor('brock', '0000444');

    const res = await lend([T1], misty.userId);
    expect(res.status).toBe(201);
    const { leases } = await json<{ leases: Record<string, unknown>[] }>(res);
    expect(leases).toEqual([
      expect.objectContaining({ tournamentId: T1, lessee: expect.objectContaining({ username: 'misty' }), notice: 'genie_unavailable', mine: 'organizer' }),
    ]);
    const text = JSON.stringify(leases);
    expect(text).not.toMatch(/ory_rt_|ciphertext|password|notice_message_id|noticeMessageId/);

    expect((await json<{ leases: unknown[] }>(await owner.request('/api/tournament-leases'))).leases).toHaveLength(1);
    expect((await json<{ leases: { mine: string }[] }>(await misty.browser.request('/api/tournament-leases'))).leases).toEqual([expect.objectContaining({ mine: 'lessee' })]);
    expect((await json<{ leases: unknown[]; lessees: { username: string }[] }>(await brock.browser.request('/api/tournament-leases'))).leases).toEqual([]);
    expect(server.logs()).toMatch(/tournament lease granted/);
  });

  it('refuses what a grant may not do, writing nothing', async () => {
    const misty = await professor('misty', '0000333');
    const gary = await professor('gary', '0000555', [ELSEWHERE]);

    const ownerId = (db.prepare("select id from app_user where username = 'organizer'").get() as { id: number }).id;
    const theirs = await lend([T1], ownerId, misty.browser);
    expect(theirs.status).toBe(409);
    expect(await json(theirs)).toMatchObject({ data: { code: 'lease_refused', refusals: [{ tournamentId: T1, code: 'not_your_tournament' }] } });

    const self = await lend([T1], ownerId);
    expect([self.status, await codeOf(self)]).toEqual([400, 'lessee_is_you']);
    for (const lesseeUserId of [gary.userId, 999]) {
      const res = await lend([T1], lesseeUserId);
      expect([res.status, await codeOf(res)]).toEqual([409, 'lessee_not_member']);
    }
    for (const body of [{}, { tournamentIds: [], lesseeUserId: misty.userId }, { tournamentIds: ['not-a-guid'], lesseeUserId: misty.userId }, { tournamentIds: [T1], lesseeUserId: 0 }]) {
      expect((await owner.request('/api/tournament-leases', { method: 'POST', json: body })).status).toBe(400);
    }
    expect((await lend([T1], misty.userId, owner, { endsAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect(db.prepare('select count(*) n from tournament_lease').get()).toEqual({ n: 0 });
  });

  it("lets the lent professor staff the tournament through the owner's connection, and nobody else", async () => {
    const misty = await professor('misty', '0000333');
    const brock = await professor('brock', '0000444');
    expect((await lend([T1], misty.userId)).status).toBe(201);

    expect((await addStaffer(misty.browser, '00777')).status).toBe(201);
    const brocks = await addStaffer(brock.browser, '00778');
    expect([brocks.status, await codeOf(brocks)]).toEqual([403, 'not_your_connection']);
    const cancel = await misty.browser.request(`/api/tournaments/${T1}/cancel`, { method: 'POST', json: {} });
    expect([cancel.status, await codeOf(cancel)]).toEqual([403, 'not_your_connection']);

    fake.requests.length = 0;
    const apply = await misty.browser.request(`/api/sessions/${date}/staff/apply`, { method: 'POST', json: { tournamentId: T1 } });
    expect(apply.status).toBe(202);
    const { submissionId } = await json<{ submissionId: number }>(apply);
    const job = await finished(misty.browser, submissionId);
    expect(job).toMatchObject({ status: 'succeeded', startedBy: 'misty', leased: true, professor: { playerId: FAKE_PLAYER_ID } });
    const writes = fake.requests.filter((r) => r.method === 'POST' && r.path === `/services/core/tournaments/${T1}/records`);
    expect(writes.map((r) => r.as)).toEqual([FAKE_PLAYER_ID]);
    expect(db.prepare('select started_by, lease_id from submission where id = ?').get(submissionId)).toEqual({ started_by: 'misty', lease_id: expect.any(Number) });
  });

  it('stops a leased staff job before its next write once the organizer ends the lease', async () => {
    const misty = await professor('misty', '0000333');
    const { leases } = await json<{ leases: { id: number }[] }>(await lend([T1], misty.userId));
    for (const p of ['00771', '00772', '00773']) expect((await addStaffer(misty.browser, p)).status).toBe(201);

    const gate = fake.holdAssigns();
    const { submissionId } = await json<{ submissionId: number }>(await misty.browser.request(`/api/sessions/${date}/staff/apply`, { method: 'POST', json: { tournamentId: T1 } }));
    await gate.arrived;
    const ended = await owner.request(`/api/tournament-leases/${leases[0]!.id}`, { method: 'DELETE' });
    expect(ended.status).toBe(200);
    expect(await json(ended)).toMatchObject({ lease: { endReason: 'ended' }, endNotice: 'genie_unavailable' });
    gate.release();

    const job = await finished(misty.browser, submissionId);
    expect(job).toMatchObject({ error: 'lease_ended' });
    const writes = fake.requests.filter((r) => r.method === 'POST' && r.path === `/services/core/tournaments/${T1}/records`);
    expect(writes).toHaveLength(1);
    expect((await addStaffer(misty.browser, '00774')).status).toBe(403);
  });

  it('ends a lease only for its organizer or lent professor, and shows it on every member’s card until then', async () => {
    const misty = await professor('misty', '0000333');
    const brock = await professor('brock', '0000444');
    const { leases } = await json<{ leases: { id: number }[] }>(await lend([T1], misty.userId));

    const cardOf = async (browser: Browser) =>
      (await json<{ tournaments: { tournamentId: string; lease: unknown }[] }>(await browser.request(`/api/sessions/${date}/staff`))).tournaments.find((t) => t.tournamentId === T1)!.lease;
    const upcomingOf = async (browser: Browser) =>
      (await json<{ tournaments: { tournamentId: string | null; lease: unknown }[] }>(await browser.request(`/api/tournaments/upcoming?from=${date}&to=${date}`))).tournaments.find(
        (t) => t.tournamentId === T1,
      )!.lease;
    expect(await cardOf(brock.browser)).toEqual({ id: leases[0]!.id, lesseeUserId: misty.userId, lesseeName: 'misty', organizerName: expect.any(String), endsAt: expect.any(String) });
    expect(await upcomingOf(brock.browser)).toMatchObject({ lesseeUserId: misty.userId });

    const theirs = await brock.browser.request(`/api/tournament-leases/${leases[0]!.id}`, { method: 'DELETE' });
    expect([theirs.status, await codeOf(theirs)]).toEqual([404, 'lease_not_found']);
    const back = await misty.browser.request(`/api/tournament-leases/${leases[0]!.id}`, { method: 'DELETE' });
    expect(await json(back)).toMatchObject({ lease: { endReason: 'given_back' }, endNotice: 'none' });

    expect(await cardOf(brock.browser)).toBeNull();
    // Served from the listing cache: the lease is added after it, so its ending shows at once.
    expect(await upcomingOf(brock.browser)).toBeNull();
    expect(server.logs()).toMatch(/tournament lease ended/);
  });

  it('guards every lease route', async () => {
    const gary = await professor('gary', '0000555', [ELSEWHERE]);
    const anonymous = client(server.url);
    for (const [path, method] of [
      ['/api/tournament-leases', 'GET'],
      ['/api/tournament-leases', 'POST'],
      ['/api/tournament-leases/1', 'DELETE'],
    ] as const) {
      expect((await anonymous.request(path, { method, ...(method === 'POST' && { json: {} }) })).status).toBe(401);
      const outside = await gary.browser.request(path, { method, ...(method === 'POST' && { json: { tournamentIds: [T1], lesseeUserId: 1 } }) });
      expect([outside.status, await codeOf(outside)]).toEqual([403, 'not_a_member']);
    }
    expect((await owner.request('/api/tournament-leases/abc', { method: 'DELETE' })).status).toBe(400);
  });
});

describe('results under a lease', () => {
  let server: TestServer;
  let owner: Browser;
  let db: Database.Database;
  const T3 = 'aaaaaaaa-0000-4000-8000-000000000003';
  const DATE = leagueDay(-1, ZONE);
  const displayId = '26-10-955555';
  const file = () =>
    tomTdf({
      players: [{ userid: '1234567', first: 'Ash', last: 'Ketchum' }],
      idElement: `<id>${displayId}</id>`,
      organizerElement: `<organizer popid="${FAKE_PLAYER_ID}" name="Olive Organizer"/>`,
    });

  async function professor(username: string, playerId: string) {
    const { secret } = await json<{ secret: string }>(await owner.request('/api/professors/invites', { method: 'POST', json: { send: 'copy' } }));
    const browser = client(server.url);
    expect((await browser.request('/api/invites/accept', { method: 'POST', json: { secret, username, password: 'water types' } })).status).toBe(201);
    const account = fake.addAccount({ playerId, name: username, leagues: [CARD_SHOP] });
    expect((await connect(browser, account.code)).status).toBe(200);
    const userId = (db.prepare('select id from app_user where username = ?').get(username) as { id: number }).id;
    return { browser, userId };
  }

  async function finished(browser: Browser, res: Response) {
    expect(res.status).toBe(202);
    const { submissionId } = await json<{ submissionId: number }>(res);
    for (let i = 0; i < 400; i++) {
      const view = await json<{ status: string }>(await browser.request(`/api/submissions/${submissionId}`));
      if (!['planned', 'running'].includes(view.status)) return view as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the job did not finish');
  }

  async function send(browser: Browser) {
    const res = await browser.request(`/api/sessions/${DATE}/tournaments/${T3}/results`, { method: 'POST', json: { filename: 'cup.tdf', content: file() } });
    expect(res.status).toBe(200);
    const p = await json<{ uploadId: number; fingerprint: string }>(res);
    return browser.request(`/api/sessions/${DATE}/tournaments/${T3}/results/${p.uploadId}/confirm`, {
      method: 'POST',
      json: { importAttendance: false, acknowledgedWarnings: p.fingerprint },
    });
  }

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.accounts.splice(1);
    fake.leagues = [CARD_SHOP];
    fake.tournaments = [fakeTournament('d3', { startsAt: localInstant(DATE, '18:00', ZONE).toISOString().replace('.000', ''), displayId })];
    fake.tournaments[0]!.guid = T3;
    fake.tournamentRecords = new Map([[T3, [fakeRecord(FAKE_PLAYER_ID, { role: 'organizer', first: 'Olive', last: 'Organizer' })]]]);
    server = await startServer({ env: { ...fake.env, TZ: ZONE, NUXT_TOURNAMENT_DELAY_MS: '0', NUXT_INVITE_RATE_LIMIT_MAX: '1000' } });
    owner = client(server.url);
    expect((await owner.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } })).status).toBe(200);
    expect((await connect(owner)).status).toBe(200);
    db = new Database(join(server.dataDir, 'app.db'));
    db.pragma('busy_timeout = 5000');
  });
  afterEach(async () => {
    db.close();
    await server.dispose();
  });

  it("lets the lent professor send the results and download the file while the lease lasts, but never delete it", async () => {
    const misty = await professor('misty', '0000333');
    const brock = await professor('brock', '0000444');
    const { leases } = await json<{ leases: { id: number }[] }>(await owner.request('/api/tournament-leases', { method: 'POST', json: { tournamentIds: [T3], lesseeUserId: misty.userId } }));

    const job = await finished(misty.browser, await send(misty.browser));
    expect(job).toMatchObject({ status: 'succeeded', leased: true, startedBy: 'misty', tournamentItems: [{ outcome: 'processing' }] });

    expect((await misty.browser.request(`/api/tournaments/${T3}/tdf`)).status).toBe(200);
    expect((await brock.browser.request(`/api/tournaments/${T3}/tdf`)).status).toBe(404);
    const files = await json<{ files: { id: number }[] }>(await misty.browser.request('/api/tdf-files'));
    expect(files.files).toHaveLength(1); // she uploaded it
    expect((await misty.browser.request(`/api/tdf-files/${files.files[0]!.id}`, { method: 'DELETE' })).status).toBe(404);

    expect((await owner.request(`/api/tournament-leases/${leases[0]!.id}`, { method: 'DELETE' })).status).toBe(200);
    const organizerName = await misty.browser.request(`/api/sessions/${DATE}/tournaments/${T3}/results`, { method: 'POST', json: { filename: 'cup.tdf', content: file() } });
    expect(organizerName.status).toBe(403);
  });

  it('finishes the confirm when the lease ends after play-tools validated the file', async () => {
    const misty = await professor('misty', '0000333');
    const { leases } = await json<{ leases: { id: number }[] }>(await owner.request('/api/tournament-leases', { method: 'POST', json: { tournamentIds: [T3], lesseeUserId: misty.userId } }));

    const gate = fake.holdValidates();
    const sent = send(misty.browser);
    await gate.arrived;
    expect((await owner.request(`/api/tournament-leases/${leases[0]!.id}`, { method: 'DELETE' })).status).toBe(200);
    gate.release();

    const job = await finished(misty.browser, await sent);
    expect(job).toMatchObject({ tournamentItems: [{ outcome: 'processing' }] });
    expect(fake.requests.filter((r) => r.method === 'PUT' && r.path.startsWith('/services/triumph/'))).toHaveLength(1);
  });
});
