import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_PLAYER_ID, type FakePokemon, fakeTournament, startFakePokemon } from './fake-pokemon';
import { mintToken } from './genie';
import { type TestServer, client, startServer } from './harness';

// Calendar feeds (ADR-0016) over HTTP against the real server: Settings turns feeds on, rotates and turns them off,
// and the feed route answers calendar apps from the snapshot with only the secret in its URL.

const OWNER = { username: 'organizer', password: 'correct horse' };
const CARD_SHOP = { guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true };
const ELSEWHERE = { guid: 'group-2', display_id: 'L7000', display_name: 'Game Den', canSubmit: true };
const ZONE = 'America/Chicago';
const MISTY_ID = '0000333';
const GARY_ID = '0000666';
const OWNERS = 'aaaaaaaa-0000-4000-8000-000000000001';
const MISTYS = 'aaaaaaaa-0000-4000-8000-000000000002';
const DAY = 86_400_000;
const FEED = '/api/calendar/v1/feed.ics';

type Browser = ReturnType<typeof client>;
type Minted = { kind: string; feed: { hint: string }; url: string; webcalUrl: string; reach: string };

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const codeOf = async (res: Response) => (await json<{ data?: { code?: string } }>(res)).data?.code;
const secretOf = (m: Minted) => new URL(m.url).searchParams.get('token')!;
/** Undoes RFC 5545 line folding: a CRLF followed by one space joins the lines. */
const unfold = (body: string) => body.replace(/\r\n /g, '');
const uids = (body: string) => [...unfold(body).matchAll(/^UID:(.+)\r$/gm)].map((m) => m[1]).sort();

async function connect(browser: Browser, code = 'fresh') {
  const start = await browser.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL((await json<{ authorizeUrl: string }>(start)).authorizeUrl).searchParams.get('state');
  return browser.request('/api/pokemon/connect/complete', { method: 'POST', json: { url: `https://play-tools.pokemon.com/loggedIn?code=${code}&state=${state}` } });
}

/** A server with the owner connected, Misty (a member) and Gary (connected outside the league). */
async function league(env: Record<string, string> = {}) {
  const server = await startServer({ env: { ...fake.env, TZ: ZONE, NUXT_INVITE_RATE_LIMIT_MAX: '1000', ...env } });
  const owner = client(server.url);
  expect((await owner.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } })).status).toBe(200);
  expect((await connect(owner)).status).toBe(200);
  const db = new Database(join(server.dataDir, 'app.db'));
  db.pragma('busy_timeout = 5000');

  async function professor(username: string, playerId: string, leagues = [CARD_SHOP]) {
    const { secret } = await json<{ secret: string }>(await owner.request('/api/professors/invites', { method: 'POST', json: { send: 'copy' } }));
    const browser = client(server.url);
    expect((await browser.request('/api/invites/accept', { method: 'POST', json: { secret, username, password: 'water types' } })).status).toBe(201);
    const account = fake.addAccount({ playerId, name: username, leagues });
    expect((await connect(browser, account.code)).status).toBe(200);
    const userId = (db.prepare('select id from app_user where username = ?').get(username) as { id: number }).id;
    return { browser, userId };
  }

  return { server, owner, db, professor };
}

function seedPlayTools() {
  fake.leagues = [CARD_SHOP];
  fake.accounts.splice(1);
  const soon = Date.now() + 3 * DAY;
  fake.tournaments = [
    fakeTournament(OWNERS, { startsAt: new Date(soon).toISOString(), organizer: FAKE_PLAYER_ID, name: 'Olive Cup', displayId: '26-10-900001' }),
    fakeTournament(MISTYS, { startsAt: new Date(soon + DAY).toISOString(), organizer: MISTY_ID, name: 'Misty Challenge', displayId: '26-10-900002' }),
  ];
  fake.playSessions = [
    {
      guid: 'bbbbbbbb-0000-4000-8000-000000000001',
      type: 'open_play',
      status: 'pending',
      start_date: new Date(soon + 2 * DAY).toISOString(),
      end_date: null,
      final_modifiable_datetime: null,
      products: ['tcg', 'vg'],
    },
  ];
}

const mint = async (as: Browser, which: 'me' | 'public') => {
  const res = await as.request(`/api/calendar-feeds/${which}`, { method: 'POST' });
  expect([200, 201]).toContain(res.status);
  return { res, minted: await json<Minted>(res) };
};

describe('calendar feeds', () => {
  let server: TestServer;
  let owner: Browser;
  let db: Database.Database;
  let misty: { browser: Browser; userId: number };
  let gary: { browser: Browser; userId: number };

  beforeAll(async () => {
    seedPlayTools();
    ({ server, owner, db } = await league().then(async (l) => {
      misty = await l.professor('misty', MISTY_ID);
      gary = await l.professor('gary', GARY_ID, [ELSEWHERE]);
      return l;
    }));
  });
  afterAll(async () => {
    db.close();
    await server.dispose();
  });
  beforeEach(() => {
    fake.requests.length = 0;
  });

  describe('Settings routes', () => {
    it('turns the public feed on once, with a link shown only in this answer, and rotates it on a second call', async () => {
      const first = await mint(owner, 'public');
      expect(first.res.status).toBe(201);
      expect(first.res.headers.get('cache-control')).toBe('no-store');
      expect(first.minted).toEqual({
        kind: 'public',
        feed: { hint: expect.stringMatching(/^ppa_cal_…[A-Za-z0-9_-]{4}$/), createdAt: expect.any(String), lastReadAt: null },
        url: expect.stringMatching(new RegExp(`^${server.url}${FEED}\\?token=ppa_cal_[A-Za-z0-9_-]{43}$`)),
        webcalUrl: expect.stringMatching(/^webcal:\/\//),
        reach: 'local_only',
      });

      const second = await mint(owner, 'public');
      expect(second.res.status).toBe(200);
      expect(secretOf(second.minted)).not.toBe(secretOf(first.minted));
      expect((await fetch(first.minted.url)).status).toBe(404);
      expect((await fetch(second.minted.url)).status).toBe(200);

      const view = await json(await owner.request('/api/calendar-feeds'));
      expect(JSON.stringify(view)).not.toContain(secretOf(second.minted));
      expect(view).toMatchObject({ public: { hint: second.minted.feed.hint }, me: null, reach: 'local_only' });
    });

    it('lets a professor hold their own feed only, and never see or change the public one', async () => {
      const { minted } = await mint(misty.browser, 'me');
      expect(minted.kind).toBe('user');

      const view = await json(await misty.browser.request('/api/calendar-feeds'));
      expect(view).toMatchObject({ me: { hint: minted.feed.hint } });
      expect(view).not.toHaveProperty('public');
      for (const method of ['POST', 'DELETE']) {
        const res = await misty.browser.request('/api/calendar-feeds/public', { method });
        expect(res.status).toBe(403);
        expect(await codeOf(res)).toBe('owner_only');
      }
    });

    it('refuses every route to a signed-out caller, and to a professor outside the league', async () => {
      const routes: [string, string][] = [
        ['GET', '/api/calendar-feeds'],
        ['POST', '/api/calendar-feeds/me'],
        ['DELETE', '/api/calendar-feeds/me'],
        ['POST', '/api/calendar-feeds/public'],
        ['DELETE', '/api/calendar-feeds/public'],
      ];
      for (const [method, path] of routes) {
        expect((await fetch(`${server.url}${path}`, { method })).status, `${method} ${path} signed out`).toBe(401);
        const res = await gary.browser.request(path, { method });
        expect(res.status, `${method} ${path} as Gary`).toBe(403);
        expect(await codeOf(res)).toBe(path.endsWith('/public') ? 'owner_only' : 'not_a_member');
      }
    });

    it('turns a feed off, so its link stops working, and turning it off again is fine', async () => {
      const { minted } = await mint(owner, 'me');

      expect((await owner.request('/api/calendar-feeds/me', { method: 'DELETE' })).status).toBe(204);
      expect((await owner.request('/api/calendar-feeds/me', { method: 'DELETE' })).status).toBe(204);
      expect((await fetch(minted.url)).status).toBe(404);
    });

    it('ignores a body sent with a request that takes none', async () => {
      const res = await owner.request('/api/calendar-feeds/me', { method: 'POST', json: { kind: 'public', userId: misty.userId } });
      expect((await json<Minted>(res)).kind).toBe('user');
    });
  });

  describe('the feed route', () => {
    it('serves the public feed: the league’s tournaments and sessions, nothing personal, and no call to play-tools', async () => {
      const { minted } = await mint(owner, 'public');
      fake.requests.length = 0;

      const res = await fetch(minted.url);
      const body = unfold(await res.text());

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('private, max-age=300');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
      expect(uids(body)).toEqual([
        'session-bbbbbbbb-0000-4000-8000-000000000001@default.play-pokemon-attendance',
        `tournament-${OWNERS}@default.play-pokemon-attendance`,
        `tournament-${MISTYS}@default.play-pokemon-attendance`,
      ]);
      expect(body).toContain('SUMMARY:Olive Cup');
      expect(body).toContain('SUMMARY:Open play · TCG\\, VG');
      expect(body).not.toMatch(new RegExp(`${FAKE_PLAYER_ID}|${MISTY_ID}|league@example\\.com|26-10-90000|Olive Organizer`));
      expect(fake.requests).toEqual([]);
    });

    it("serves a professor's feed with only the tournaments they organize", async () => {
      const { minted } = await mint(misty.browser, 'me');

      const body = unfold(await (await fetch(minted.url)).text());

      expect(body).toContain('X-WR-CALNAME:Card Shop: my tournaments');
      expect(uids(body)).toEqual([`tournament-${MISTYS}@default.play-pokemon-attendance`]);
      expect(body).toContain('DESCRIPTION:You organize\\nTCG');
    });

    it('answers If-None-Match with the current ETag with 304, and HEAD like GET without the body', async () => {
      const { minted } = await mint(owner, 'public');
      const first = await fetch(minted.url);
      const etag = first.headers.get('etag')!;

      const again = await fetch(minted.url, { headers: { 'if-none-match': etag } });
      expect(again.status).toBe(304);
      expect(await again.text()).toBe('');

      const head = await fetch(minted.url, { method: 'HEAD' });
      expect(head.status).toBe(200);
      for (const name of ['content-type', 'cache-control', 'etag', 'x-robots-tag']) expect(head.headers.get(name), name).toBe(first.headers.get(name));
      expect(await head.text()).toBe('');
    });

    it.each(['POST', 'PUT', 'DELETE'])('answers %s with the JSON 404 of an unknown route', async (method) => {
      const { minted } = await mint(owner, 'public');
      const res = await fetch(minted.url, { method });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/json/);
    });

    it('refuses every unusable credential with the same empty 404', async () => {
      const rotated = secretOf((await mint(owner, 'public')).minted);
      await mint(owner, 'public');
      const off = secretOf((await mint(misty.browser, 'me')).minted);
      await misty.browser.request('/api/calendar-feeds/me', { method: 'DELETE' });
      // Gary, outside the league, can't turn a feed on; a member's feed is made outside by moving her connection.
      expect((await gary.browser.request('/api/calendar-feeds/me', { method: 'POST' })).status).toBe(403);
      const outside = secretOf((await mint(misty.browser, 'me')).minted);
      db.prepare(`update league_membership set status = 'outside' where connection_id in (select id from pokemon_connection where professor_player_id = ?)`).run(MISTY_ID);
      const integration = await mintToken(owner, ['integrations:read']);

      const attempts: [string, RequestInit][] = [
        [FEED, {}],
        [`${FEED}?token=abc`, {}],
        [`${FEED}?token=ppa_cal_${'A'.repeat(43)}`, {}],
        [`${FEED}?token=${rotated}`, {}],
        [`${FEED}?token=${off}`, {}],
        [`${FEED}?token=${outside}`, {}],
        [`${FEED}?token=${outside}&token=${outside}`, {}],
        [`${FEED}?token=${encodeURIComponent(` ${outside}`)}`, {}],
        [`${FEED}?token=${'ppa_cal_'.padEnd(2048, 'A')}`, {}],
        [`${FEED}?token=${encodeURIComponent("' or 1=1 --<script>")}`, {}],
        [FEED, { headers: { cookie: owner.cookie } }],
        [FEED, { headers: { authorization: `Bearer ${integration}` } }],
      ];
      const answers = [];
      for (const [path, init] of attempts) {
        const res = await fetch(`${server.url}${path}`, init);
        answers.push({ status: res.status, body: await res.text(), headers: [...res.headers].filter(([k]) => k !== 'date' && k !== 'x-request-id') });
      }
      for (const a of answers) expect(a).toEqual(answers[0]);
      expect(answers[0]).toMatchObject({ status: 404, body: '' });

      db.prepare(`update league_membership set status = 'member' where connection_id in (select id from pokemon_connection where professor_player_id = ?)`).run(MISTY_ID);
    });

    it('takes a calendar secret nowhere else', async () => {
      const secret = secretOf((await mint(owner, 'public')).minted);
      const day = await fetch(`${server.url}/api/integrations/v1/days/2026-10-22`, { headers: { authorization: `Bearer ${secret}` } });
      expect(day.status).toBe(401);
      expect((await fetch(`${server.url}/api/calendar-feeds?token=${secret}`)).status).toBe(401);
    });

    it('answers 503 with Retry-After while a membership is unknown, and for a league with no activity group', async () => {
      const { minted } = await mint(misty.browser, 'me');
      const setMisty = (status: string) =>
        db.prepare(`update league_membership set status = ? where connection_id in (select id from pokemon_connection where professor_player_id = ?)`).run(status, MISTY_ID);

      setMisty('unknown');
      const unknown = await fetch(minted.url);
      setMisty('member');
      expect(unknown.status).toBe(503);
      expect(unknown.headers.get('retry-after')).toBe('3600');
      expect(await unknown.text()).toBe('');

      const saved = db.prepare('select * from league_upstream').all() as Record<string, unknown>[];
      db.prepare('delete from league_upstream').run();
      const noLeague = await fetch(minted.url);
      for (const row of saved) {
        const cols = Object.keys(row);
        db.prepare(`insert into league_upstream (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
      }
      expect(noLeague.status).toBe(503);
    });

    it('logs one line per fetch without the secret, and answers an unexpected failure with an empty 503 that logs no URL', async () => {
      const { minted } = await mint(owner, 'public');
      const secret = secretOf(minted);
      const from = server.logs().length;

      await fetch(minted.url);
      await server.waitForLog(/calendar feed read/, { from });

      const saved = db.prepare(`select events from calendar_snapshot`).get() as { events: string };
      db.prepare(`update calendar_snapshot set events = 'not json'`).run();
      const broken = await fetch(minted.url);
      db.prepare(`update calendar_snapshot set events = ?`).run(saved.events);

      expect(broken.status).toBe(503);
      expect(broken.headers.get('retry-after')).toBe('3600');
      expect(await broken.text()).toBe('');
      await server.waitForLog(/calendar feed fetch failed/, { from });
      expect(server.logs()).not.toContain(secret);
    });

    it("stops a removed professor's feed", async () => {
      const brock = await (async () => {
        const { secret } = await json<{ secret: string }>(await owner.request('/api/professors/invites', { method: 'POST', json: { send: 'copy' } }));
        const browser = client(server.url);
        expect((await browser.request('/api/invites/accept', { method: 'POST', json: { secret, username: 'brock', password: 'rock types' } })).status).toBe(201);
        const account = fake.addAccount({ playerId: '0000444', name: 'brock', leagues: [CARD_SHOP] });
        expect((await connect(browser, account.code)).status).toBe(200);
        return { browser, userId: (db.prepare("select id from app_user where username = 'brock'").get() as { id: number }).id };
      })();
      const { minted } = await mint(brock.browser, 'me');
      expect((await fetch(minted.url)).status).toBe(200);

      expect((await owner.request(`/api/professors/${brock.userId}`, { method: 'DELETE' })).status).toBe(204);

      expect((await fetch(minted.url)).status).toBe(404);
      expect(db.prepare('select count(*) as n from calendar_feed where user_id = ?').get(brock.userId)).toEqual({ n: 0 });
    });
  });
});

describe('calendar feed rate limits', () => {
  let server: TestServer;
  let owner: Browser;
  let db: Database.Database;

  beforeAll(async () => {
    seedPlayTools();
    ({ server, owner, db } = await league({ NUXT_CALENDAR_FETCH_RATE_LIMIT_MAX: '3', NUXT_CALENDAR_REFUSAL_RATE_LIMIT_MAX: '3' }));
  });
  afterAll(async () => {
    db.close();
    await server.dispose();
  });

  const from = (ip: string) => ({ headers: { 'x-forwarded-for': ip } });

  it('limits one client on one feed, while other clients still fetch it', async () => {
    const { minted } = await mint(owner, 'public');

    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(minted.url, from('203.0.113.1'))).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await fetch(minted.url, from('203.0.113.1'));
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    expect((await fetch(minted.url, from('203.0.113.2'))).status).toBe(200);
  });

  it('limits a client sending secrets that match nothing, and never blocks a valid secret', async () => {
    const { minted } = await mint(owner, 'me');

    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${server.url}${FEED}?token=ppa_cal_${String(i).padEnd(43, 'B')}`, from('203.0.113.9'))).status);
    expect(statuses).toEqual([404, 404, 404, 429]);

    expect((await fetch(minted.url, from('203.0.113.9'))).status).toBe(200);
  });
});
