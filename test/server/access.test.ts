import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PLAYER_ID, type FakePokemon, type FakePlaySession, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, startServer } from './harness';

// Who may call what (ADR-0015 §3, §4 and §8), driven over HTTP against the real server and the Pokémon fake. Inviting is
// tested in invites.test.ts, so these tests add professor rows to the database directly, with the owner's password.

const OWNER = { username: 'organizer', password: 'correct horse' };
const TUESDAY = '2026-10-13';
const PS = 'ps-tuesday';
const SESSION: FakePlaySession = {
  guid: PS,
  type: 'open_play',
  status: 'active',
  start_date: '2026-10-13T23:00:00Z',
  end_date: '2026-10-14T02:00:00Z',
  final_modifiable_datetime: '2099-01-01T00:00:00Z',
  products: ['tcg'],
};
const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };
const ENV = { TZ: 'America/Chicago', NUXT_SUBMISSION_BATCH_DELAY_MS: '0', NUXT_UNDO_DELAY_MS: '0' };

type Browser = ReturnType<typeof client>;

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

// --- the route table, as test/unit/route-guards.test.ts holds the files to it ---------------------------------------

const API = join(process.cwd(), 'server', 'api');
const ACTOR = new Set([
  'settings.get.ts',
  'pokemon/connections.get.ts',
  'pokemon/connect/start.post.ts',
  'pokemon/connect/complete.post.ts',
  'pokemon/connections/[playerId].patch.ts',
  'pokemon/connections/[playerId].delete.ts',
]);
const OWNER_ONLY = new Set([
  'professors/index.get.ts',
  'professors/invites/index.post.ts',
  'professors/invites/[id].delete.ts',
  'professors/[userId]/reset-link.post.ts',
  'professors/[userId].delete.ts',
  'leagues/upstream.get.ts',
  'settings.put.ts',
  'staff/import.post.ts',
  'players/import.post.ts',
  'integrations/tokens/index.get.ts',
  'integrations/tokens/index.post.ts',
  'integrations/tokens/[id].delete.ts',
  'sessions/[date]/clear.get.ts',
  'sessions/[date]/clear.post.ts',
]);
const PARAMS: Record<string, string> = {
  date: TUESDAY,
  playerId: '0012345',
  id: '1',
  assignmentId: '1',
  uploadId: '1',
  tournamentId: '00000000-0000-4000-8000-000000000001',
  periodStart: '2026-10-01',
  userId: '2',
};

interface Route {
  file: string;
  method: string;
  path: string;
  guard: 'actor' | 'member' | 'owner';
}

function routes(dir = API): Route[] {
  return readdirSync(dir).flatMap((name): Route[] => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routes(full);
    const file = relative(API, full).split(sep).join('/');
    const m = /^(.*?)(?:\.(get|post|put|patch|delete))?\.ts$/.exec(file);
    if (!m || file.endsWith('.test.ts') || file.startsWith('auth/') || file.startsWith('invites/') || file.startsWith('integrations/v1/') || file.includes('[...]') || file === 'index.ts') return [];
    const path = `/api/${m[1]!.replace(/\/index$/, '').replace(/^index$/, '')}`.replace(/\[(\w+)\]/g, (_s, p: string) => {
      if (p === 'id' && file.startsWith('tournaments/[id]')) return PARAMS.tournamentId!;
      return PARAMS[p] ?? '1';
    });
    const guard = ACTOR.has(file) ? 'actor' : OWNER_ONLY.has(file) ? 'owner' : 'member';
    return [{ file, method: (m[2] ?? 'get').toUpperCase(), path, guard }];
  });
}

const ALL = routes();
const asCase = (r: Route) => [`${r.method} ${r.path}`, r] as const;

// --- helpers ------------------------------------------------------------------------------------------------------

async function connect(browser: Browser, code = 'fresh') {
  const start = await browser.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL(((await start.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state');
  return browser.request('/api/pokemon/connect/complete', { method: 'POST', json: { url: `https://play-tools.pokemon.com/loggedIn?code=${code}&state=${state}` } });
}

const send = (browser: Browser, r: Route) => browser.request(r.path, { method: r.method, json: r.method === 'GET' ? undefined : {} });
const codeOf = async (res: Response) => ((await res.json()) as { data?: { code?: string } }).data?.code;

describe('access to the league (ADR-0015)', () => {
  let server: TestServer;
  let owner: Browser;
  let db: Database.Database;

  /** A professor row as an invite makes it, signed in with the owner's password. */
  async function professor(username: string, opts: { removed?: boolean } = {}): Promise<Browser> {
    db.prepare(
      `insert into app_user (username, password_hash, role, created_at) select ?, password_hash, 'professor', 1 from app_user where role = 'owner'`,
    ).run(username);
    const browser = client(server.url);
    expect((await browser.request('/api/auth/login', { method: 'POST', json: { username, password: OWNER.password } })).status).toBe(200);
    if (opts.removed) db.prepare('update app_user set removed_at = 1 where username = ?').run(username);
    return browser;
  }

  /** A professor who connected their own account, confirmed in the league. */
  async function member(username: string, playerId: string): Promise<Browser> {
    const browser = await professor(username);
    const account = fake.addAccount({ playerId, name: username, leagues: [CARD_SHOP] });
    expect((await connect(browser, account.code)).status).toBe(200);
    return browser;
  }

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.accounts.splice(1);
    fake.leagues = [CARD_SHOP];
    fake.playSessions = [SESSION];
    fake.records = new Map([[PS, [fakeRecord(FAKE_PLAYER_ID, { role: 'organizer' })]]]);
    fake.bulkDelayMs = 0;
    server = await startServer({ env: { ...fake.env, ...ENV } });
    owner = client(server.url);
    expect((await owner.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } })).status).toBe(200);
    db = new Database(join(server.dataDir, 'app.db'));
    db.pragma('busy_timeout = 5000');
  });
  afterEach(async () => {
    db.close();
    expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
    await server.dispose();
  });

  describe('every guarded route', () => {
    it('finds the routes', () => {
      expect(ALL.length).toBeGreaterThan(75);
    });

    it.each(ALL.map(asCase))('%s is 401 without a session', async (_l, r) => {
      expect((await send(client(server.url), r)).status).toBe(401);
    });

    it.each(ALL.map(asCase))("%s is 401 for a removed user's session, and clears the cookie", async (_l, r) => {
      const removed = await professor('ash', { removed: true });
      const res = await send(removed, r);
      expect(res.status).toBe(401);
      expect(res.headers.getSetCookie().join(';')).toMatch(/nuxt-session=;/);
    });

    it.each(ALL.filter((r) => r.guard !== 'actor').map(asCase))('%s is 403 for a professor outside the league', async (_l, r) => {
      const outsider = await professor('gary');
      const res = await send(outsider, r);
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe(r.guard === 'owner' ? 'owner_only' : 'not_a_member');
    });

    it.each(ALL.filter((r) => r.guard === 'member').map(asCase))(
      '%s is 403 reverify_required for a member professor who accepted a reset link and has not connected since',
      async (_l, r) => {
        await connect(owner);
        const misty = await member('misty', '0000333');
        db.prepare("update app_user set reverify_required_at = 1 where username = 'misty'").run();
        const res = await send(misty, r);
        expect(res.status).toBe(403);
        expect(await codeOf(res)).toBe('reverify_required');
      },
    );

    it.each(ALL.filter((r) => r.guard === 'owner').map(asCase))('%s is 403 owner_only for a member professor', async (_l, r) => {
      await connect(owner);
      const misty = await member('misty', '0000333');
      const res = await send(misty, r);
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('owner_only');
    });
  });

  it('is 401, clearing the cookie, for a session whose user no longer exists', async () => {
    const gone = await professor('ash');
    db.prepare("delete from app_user where username = 'ash'").run();
    const res = await gone.request('/api/settings');
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().join(';')).toMatch(/nuxt-session=;/);
  });

  describe('the waiting room', () => {
    it("shows a professor outside the league only their own account and connection, then the league once they're a member", async () => {
      await connect(owner);
      const misty = await professor('misty');
      expect(await (await misty.request('/api/settings')).json()).toEqual({ access: { username: 'misty', role: 'professor', member: false, waiting: 'no_connection' } });

      const account = fake.addAccount({ playerId: '0000333', name: 'Misty', leagues: [] });
      expect((await connect(misty, account.code)).status).toBe(200);
      const listed = (await (await misty.request('/api/pokemon/connections')).json()) as { connections: { professorPlayerId: string; mine: boolean }[] };
      expect(listed.connections).toEqual([expect.objectContaining({ professorPlayerId: '0000333', mine: true })]);
      expect((await misty.request(`/api/sessions/${TUESDAY}`)).status).toBe(403);

      db.prepare("update league_membership set status = 'member', can_submit = 1 where connection_id = (select id from pokemon_connection where professor_player_id = '0000333')").run();
      expect((await misty.request(`/api/sessions/${TUESDAY}`)).status).toBe(200);
      expect(((await (await misty.request('/api/settings')).json()) as { access: unknown }).access).toEqual({ username: 'misty', role: 'professor', member: true, waiting: null });
    });

    it('never answers a token, a ciphertext or a user id in the connections or settings answers', async () => {
      await connect(owner);
      const text = (await (await owner.request('/api/pokemon/connections')).text()) + (await (await owner.request('/api/settings')).text());
      expect(text).not.toMatch(/token|ciphertext|ptcUserId|userId|password/i);
    });
  });

  describe('who holds a connection', () => {
    it("moves the owner's connection to the professor who logs into that account, and says so", async () => {
      const brock = fake.addAccount({ playerId: '0000222', name: 'Brock', leagues: [CARD_SHOP] });
      expect((await connect(owner, brock.code)).status).toBe(200);
      const prof = await professor('brock');

      const res = await connect(prof, brock.code);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: 'claimed', connection: { professorPlayerId: '0000222', mine: true } });
      expect(await server.waitForLog(/moved from organizer to brock/)).toBeTruthy();
    });

    it("refuses the owner a connect for an account a professor holds, leaving it theirs", async () => {
      await connect(owner);
      await member('misty', '0000333');
      const mistys = fake.accounts.find((a) => a.playerId === '0000333')!;

      const res = await connect(owner, mistys.code);

      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe('connection_held');
      expect(db.prepare("select u.username from pokemon_connection c join app_user u on u.id = c.user_id where professor_player_id = '0000333'").get()).toEqual({
        username: 'misty',
      });
    });
  });

  describe('attendance as yourself', () => {
    const bulkAs = () => fake.requests.filter((r) => r.path.endsWith('/_bulk/')).map((r) => r.as);
    const submit = (browser: Browser, json: Record<string, unknown> = {}) =>
      browser.request(`/api/sessions/${TUESDAY}/submissions`, { method: 'POST', json: { playSessionId: PS, ...json } });
    async function finished(browser: Browser, id: number) {
      for (let i = 0; i < 100; i++) {
        const view = (await (await browser.request(`/api/submissions/${id}`)).json()) as { status: string };
        if (!['planned', 'running'].includes(view.status)) return view;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('submission did not finish');
    }

    beforeEach(async () => {
      await connect(owner);
      await owner.request(`/api/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '4242', name: 'Player' } });
    });

    it('asks the owner which connection when two can submit, and sends as the one named', async () => {
      const brock = fake.addAccount({ playerId: '0000222', name: 'Brock', leagues: [CARD_SHOP] });
      await connect(owner, brock.code);

      const unnamed = await submit(owner);
      expect(unnamed.status).toBe(409);
      expect(await codeOf(unnamed)).toBe('submit_as_required');

      const named = await submit(owner, { professorPlayerId: '0000222' });
      expect(named.status).toBe(202);
      await finished(owner, ((await named.json()) as { submissionId: number }).submissionId);
      expect(new Set(bulkAs())).toEqual(new Set(['0000222']));
    });

    it("sends a professor's submission as their own connection, and refuses them the owner's", async () => {
      const misty = await member('misty', '0000333');
      expect(await codeOf(await submit(misty, { professorPlayerId: FAKE_PLAYER_ID }))).toBe('not_your_connection');

      const res = await submit(misty);
      expect(res.status).toBe(202);
      await finished(misty, ((await res.json()) as { submissionId: number }).submissionId);
      expect(new Set(bulkAs())).toEqual(new Set(['0000333']));
    });

    it("refuses a professor's undo of the owner's submission, and the owner's of the professor's", async () => {
      const misty = await member('misty', '0000333');
      const ownerRun = ((await (await submit(owner)).json()) as { submissionId: number }).submissionId;
      await finished(owner, ownerRun);

      const res = await misty.request(`/api/submissions/${ownerRun}/undo`, { method: 'POST', json: {} });
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe('not_your_connection');
    });

    it('holds one job per league whoever starts it', async () => {
      const misty = await member('misty', '0000333');
      fake.bulkDelayMs = 500;
      expect((await submit(owner)).status).toBe(202);
      const second = await submit(misty);
      expect(second.status).toBe(409);
      expect(await codeOf(second)).toBe('submission_running');
    });
  });

  describe("tournaments someone else organizes", () => {
    it("refuses the owner staff on a professor's tournament, writing nothing, and lets the professor", async () => {
      await connect(owner);
      const misty = await member('misty', '0000333');
      fake.tournaments = [fakeTournament('mistys-cup', { startsAt: '2026-10-14T23:30:00Z', organizer: '0000333', name: 'Misty Cup' })];
      const add = (b: Browser, playerId: string) =>
        b.request('/api/sessions/2026-10-14/staff', { method: 'POST', json: { tournamentId: 'mistys-cup', playerId, role: 'judge' } });
      fake.requests.length = 0;

      const refused = await add(owner, '00555');
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ data: { code: 'not_your_connection', professorPlayerId: '0000333' } });
      expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);

      expect((await add(misty, '00556')).status).toBe(201);
    });
  });

  describe('shared league data', () => {
    it('lets a member professor edit the league’s own data', async () => {
      await connect(owner);
      const misty = await member('misty', '0000333');
      const ok = (res: Response) => expect([200, 201, 204]).toContain(res.status);

      ok(await misty.request(`/api/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '5151', name: 'Someone' } }));
      ok(await misty.request('/api/regulars', { method: 'POST', json: { playerId: '6161', name: 'Regular' } }));
      ok(await misty.request('/api/players/5151', { method: 'PATCH', json: { name: 'Someone Else' } }));
    });
  });

  describe('stored TDFs', () => {
    const insertFile = (sha: string, by: string) =>
      db
        .prepare(
          `insert into tdf_file (league_id, sha256, filename, byte_size, ciphertext, kept_for, created_by, created_at) values ('default', ?, ?, 1, x'00', '[]', ?, 1) returning id`,
        )
        .get(sha, `${sha}.tdf`, by) as { id: number };

    it("shows a professor only the files they uploaded or that belong to their own tournaments' results; the owner sees all", async () => {
      await connect(owner);
      const misty = await member('misty', '0000333');
      const theirs = insertFile('a', 'misty');
      const ofTheirTournament = insertFile('b', 'organizer');
      const someoneElses = insertFile('c', 'organizer');
      db.prepare(
        `insert into tournament_result_upload (league_id, tournament_id, session_date, filename, tdf_file_id, sha256, player_count, professor_player_id, state, created_at)
         values ('default', 't-1', ?, 'b.tdf', ?, 'b', 1, '0000333', 'previewed', 1)`,
      ).run(TUESDAY, ofTheirTournament.id);

      const ids = async (b: Browser) => ((await (await b.request('/api/tdf-files')).json()) as { files: { id: number }[] }).files.map((f) => f.id).sort();
      expect(await ids(misty)).toEqual([theirs.id, ofTheirTournament.id].sort());
      expect(await ids(owner)).toEqual([theirs.id, ofTheirTournament.id, someoneElses.id].sort());
      expect((await misty.request(`/api/tdf-files/${someoneElses.id}/download`)).status).toBe(404);
      expect((await misty.request(`/api/tdf-files/${someoneElses.id}`, { method: 'DELETE' })).status).toBe(404);
      expect(db.prepare('select count(*) n from tdf_file where id = ?').get(someoneElses.id)).toEqual({ n: 1 });
    });
  });
});
