import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BIRTHDATE, tomTdf } from '../../shared/tdf/__fixtures__/tom';
import { localInstant } from '../../shared/time/local-time';
import { FAKE_PLAYER_ID, type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, logRecords, setupCodeFrom, startServer } from './harness';
import { leagueDay } from './league-day';

// **Download TDF** (ADR-0012 decision 7, #97) over HTTP, against the built app and the play-tools fake. The file comes
// from the app's archive only: play-tools answers 403 for it (#107), so the fake's request log must stay empty for
// every download, connected or not, lease held or not. Which upload's file is picked is the module's test
// (results.test.ts); here a real confirmed upload is downloaded end to end.

const OWNER = { username: 'organizer', password: 'correct horse' };
const TZ = 'America/Chicago';
const ENV = { TZ, NUXT_TOURNAMENT_DELAY_MS: '0', NUXT_LOG_FORMAT: 'json' };

const day = (days: number) => leagueDay(days, TZ);
const at18 = (date: string) => localInstant(date, '18:00', TZ).toISOString().replace('.000', '');
const DATE = day(-1);
const PLAYERS = [
  { userid: '1234567', first: 'Ash', last: 'Ketchum' },
  { userid: '2345678', first: 'Misty', last: 'Waterflower' },
];
const ORGANIZER = `<organizer popid="${FAKE_PLAYER_ID}" name="Olive Organizer"/>`;

type Browser = ReturnType<typeof client>;
interface Preview {
  uploadId: number;
  fingerprint: string;
}

let fake: FakePokemon;
let serial = 0;
const body = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const code = async (res: Response) => (await body<{ data?: { code?: string } }>(res)).data?.code;

/** A play-tools tournament of yesterday, awaiting results, with a fresh guid and display id. */
function newTournament(): { guid: string; displayId: string } {
  const n = String(++serial).padStart(4, '0');
  const displayId = `26-10-8${n.padStart(5, '0')}`;
  const t = fakeTournament(`dl${n}`, { startsAt: at18(DATE), displayId });
  t.guid = `00000000-0000-4000-8000-00000000${n}`;
  fake.tournaments.push(t);
  fake.tournamentRecords.set(t.guid, [fakeRecord(FAKE_PLAYER_ID, { role: 'organizer', first: 'Olive', last: 'Organizer' })]);
  return { guid: t.guid, displayId };
}

async function signIn(server: TestServer, first: boolean): Promise<Browser> {
  const browser = client(server.url);
  const res = first
    ? await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } })
    : await browser.request('/api/auth/login', { method: 'POST', json: OWNER });
  expect(res.status).toBe(200);
  return browser;
}

async function connect(browser: Browser) {
  const start = await browser.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL((await body<{ authorizeUrl: string }>(start)).authorizeUrl).searchParams.get('state');
  const res = await browser.request('/api/pokemon/connect/complete', { method: 'POST', json: { url: `https://play-tools.pokemon.com/loggedIn?code=fresh&state=${state}` } });
  expect(res.status).toBe(200);
}

const results = (guid: string, rest = '') => `/api/sessions/${DATE}/tournaments/${guid}/results${rest}`;

async function previewResults(browser: Browser, guid: string, content: string): Promise<Preview> {
  const res = await browser.request(results(guid), { method: 'POST', json: { filename: 'cup.tdf', content } });
  expect(res.status).toBe(200);
  return body<Preview>(res);
}

function confirm(browser: Browser, guid: string, p: Preview) {
  return browser.request(results(guid, `/${p.uploadId}/confirm`), { method: 'POST', json: { importAttendance: false, acknowledgedWarnings: p.fingerprint } });
}

async function finished(browser: Browser, res: Response) {
  expect(res.status).toBe(202);
  const { submissionId } = await body<{ submissionId: number }>(res);
  for (const deadline = Date.now() + 25_000; Date.now() < deadline; ) {
    const job = await body<{ status: string }>(await browser.request(`/api/submissions/${submissionId}`));
    if (job.status !== 'planned' && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${submissionId} did not finish`);
}

/** Drops the file on the tournament's card, sends it, and lets play-tools finish: a `complete` upload. */
async function uploadResults(browser: Browser, guid: string, content: string): Promise<Preview> {
  const p = await previewResults(browser, guid, content);
  expect(await finished(browser, await confirm(browser, guid, p))).toMatchObject({ status: 'succeeded' });
  fake.finishUpload(guid, 'completed');
  const section = await body<{ latest: { state: string } }>(await browser.request(results(guid)));
  expect(section.latest.state).toBe('complete');
  return p;
}

const download = (browser: Browser, guid: string) => browser.request(`/api/tournaments/${guid}/tdf`);

/** Runs `act` and returns the play-tools requests made while it ran. */
async function upstreamDuring<T>(act: () => Promise<T>): Promise<{ result: T; requests: unknown[] }> {
  const from = fake.requests.length;
  const result = await act();
  return { result, requests: fake.requests.slice(from) };
}

async function archivedFiles(browser: Browser) {
  return (await body<{ files: { id: number; filename: string }[] }>(await browser.request('/api/tdf-files'))).files;
}

describe('GET /tournaments/{id}/tdf', () => {
  let server: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    fake = await startFakePokemon();
    server = await startServer({ env: { ...fake.env, ...ENV } });
    browser = await signIn(server, true);
    await connect(browser);
  });
  afterAll(async () => {
    expect(server.logs()).not.toContain(BIRTHDATE);
    await server.dispose();
    await fake.close();
  });
  beforeEach(() => {
    fake.tournaments = [];
    fake.tournamentRecords.clear();
  });

  it('is 401 without a session and 400 for an id that is not a tournament guid, asking play-tools nothing', async () => {
    const { requests } = await upstreamDuring(async () => {
      expect((await fetch(`${server.url}/api/tournaments/00000000-0000-4000-8000-000000000001/tdf`)).status).toBe(401);
      expect((await download(browser, 'abc')).status).toBe(400);
      expect((await download(browser, '12')).status).toBe(400);
    });
    expect(requests).toEqual([]);
  });

  it('serves the corrected file of the confirmed upload as a no-store attachment, with one audit line and no content in the logs', async () => {
    const { guid, displayId } = newTournament();
    const dropped = tomTdf({ players: PLAYERS, idElement: '<id/>', organizerElement: ORGANIZER });
    await uploadResults(browser, guid, dropped);

    const { result: res, requests } = await upstreamDuring(() => download(browser, guid.toUpperCase()));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="cup.tdf"; filename*=UTF-8''cup.tdf`);
    const served = await res.text();
    expect(served).toBe(fake.validatedFiles.at(-1));
    expect(served).toContain(`<id>${displayId}</id>`);
    expect(served).not.toBe(dropped);
    expect(requests).toEqual([]);

    const [file] = (await archivedFiles(browser)).filter((f) => f.filename === 'cup.tdf');
    const audit = logRecords(server.logs()).filter((r) => r.tournamentId === guid && /downloaded/i.test(String(r.msg)));
    expect(audit).toEqual([expect.objectContaining({ fileId: file!.id, by: OWNER.username })]);
    expect(JSON.stringify(audit)).not.toMatch(/<tournament|Ketchum/);

    // The card and the Tournaments page row know there is a file, without the content.
    const section = await browser.request(results(guid));
    expect(await body(section)).toMatchObject({ tdfAvailable: true });
    const upcoming = await body<{ tournaments: { tournamentId: string | null; tdfAvailable: boolean }[] }>(await browser.request('/api/tournaments/upcoming'));
    expect(upcoming.tournaments.find((t) => t.tournamentId === guid)).toMatchObject({ tdfAvailable: true });
  });

  it('is 404 no_tdf for a tournament whose results the app has no file of, asking play-tools nothing', async () => {
    const { guid } = newTournament();
    const { result: res, requests } = await upstreamDuring(() => download(browser, guid));
    expect(res.status).toBe(404);
    expect(await code(res)).toBe('no_tdf');
    expect(requests).toEqual([]);
  });

  it('falls back to the earlier confirmed upload when the latest file is deleted, then 404 once that is gone too', async () => {
    const { guid } = newTournament();
    const a = await uploadResults(browser, guid, tomTdf({ players: PLAYERS, organizerElement: ORGANIZER, idElement: '<id/>' }));
    // A second confirmed upload of the same tournament, its file stored by a real attendance preview: copied from the
    // first row so every column stays valid, pointing at the other file.
    const [y, m, d] = DATE.split('-');
    const later = tomTdf({ players: [PLAYERS[0]!], name: 'Later file', startdate: `${m}/${d}/${y}` });
    expect((await browser.request(`/api/sessions/${DATE}/tdf`, { method: 'POST', json: { filename: 'later.tdf', content: later } })).status).toBe(200);
    const laterFile = (await archivedFiles(browser)).find((f) => f.filename === 'later.tdf')!;
    const db = new Database(join(server.dataDir, 'app.db'));
    try {
      db.prepare('create temp table copied as select * from tournament_result_upload where id = ?').run(a.uploadId);
      db.prepare("update copied set id = null, filename = 'later.tdf', tdf_file_id = ?").run(laterFile.id);
      db.prepare('insert into tournament_result_upload select * from copied').run();
    } finally {
      db.close();
    }
    expect(await (await download(browser, guid)).text()).toBe(later);

    expect((await browser.request(`/api/tdf-files/${laterFile.id}`, { method: 'DELETE' })).status).toBe(200);
    const fallback = await download(browser, guid);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toBe(fake.validatedFiles.at(-1));

    const first = (await archivedFiles(browser)).find((f) => f.filename === 'cup.tdf')!;
    expect((await browser.request(`/api/tdf-files/${first.id}`, { method: 'DELETE' })).status).toBe(200);
    const gone = await download(browser, guid);
    expect(gone.status).toBe(404);
    expect(await code(gone)).toBe('no_tdf');
  });

  it('still serves the file while another job holds the league’s lease', async () => {
    const { guid } = newTournament();
    await uploadResults(browser, guid, tomTdf({ players: PLAYERS, organizerElement: ORGANIZER, idElement: '<id/>' }));
    const other = newTournament();
    const held = fake.holdValidates();
    const p = await previewResults(browser, other.guid, tomTdf({ players: PLAYERS, organizerElement: ORGANIZER, idElement: '<id/>' }));
    const job = await confirm(browser, other.guid, p);
    await held.arrived;
    try {
      // The other upload's job is mid-send, so the lease is held: a new job is refused.
      expect(await code(await browser.request('/api/staff/import', { method: 'POST', json: {} }))).toBe('submission_running');
      const { result: res, requests } = await upstreamDuring(() => download(browser, guid));
      expect(res.status).toBe(200);
      expect(requests).toEqual([]);
    } finally {
      held.release();
    }
    await finished(browser, job);
  });

  // Last: it disconnects the only professor.
  it('still serves the file once the tournament’s organizer is disconnected', async () => {
    const { guid } = newTournament();
    await uploadResults(browser, guid, tomTdf({ players: PLAYERS, organizerElement: ORGANIZER, idElement: '<id/>' }));
    expect((await browser.request(`/api/pokemon/connections/${FAKE_PLAYER_ID}`, { method: 'DELETE' })).status).toBe(200);

    const { result: res, requests } = await upstreamDuring(() => download(browser, guid));
    expect(res.status).toBe(200);
    expect(requests).toEqual([]);
  });
});

describe('GET /tournaments/{id}/tdf after the TDF key changes (app.db restored without its secrets)', () => {
  let server: TestServer | undefined;

  afterAll(async () => {
    await server?.dispose();
    await fake.close();
  });

  it("answers 409 tdf_key_mismatch for a file the new key can't open, with no file content", async () => {
    fake = await startFakePokemon();
    const first = await startServer({ env: { ...fake.env, ...ENV, NUXT_TDF_VAULT_KEY: randomBytes(32).toString('base64') } });
    const before = await signIn(first, true);
    await connect(before);
    const { guid } = newTournament();
    await uploadResults(before, guid, tomTdf({ players: PLAYERS, organizerElement: ORGANIZER, idElement: '<id/>' }));
    await first.stop();

    server = await startServer({ dataDir: first.dataDir, env: { ...fake.env, ...ENV, NUXT_TDF_VAULT_KEY: randomBytes(32).toString('base64') } });
    const browser = await signIn(server, false);
    const { result: res, requests } = await upstreamDuring(() => download(browser, guid));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text).data).toEqual({ code: 'tdf_key_mismatch' });
    expect(text).not.toMatch(/Ketchum|<tournament/);
    expect(requests).toEqual([]);
  });
});
