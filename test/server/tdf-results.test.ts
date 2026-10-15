import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BIRTHDATE, tomTdf } from '../../shared/tdf/__fixtures__/tom';
import { localInstant } from '../../shared/time/local-time';
import { FAKE_PLAYER_ID, type FakePokemon, fakeRecord, fakeTournament, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';
import { leagueDay } from './league-day';

// A tournament's TDF results upload (#96, ADR-0011) over HTTP, against the built app and the play-tools fake. The
// fake's request log is the oracle: a file reaches `POST triumph/tdf/` only from a confirm that carried the preview's
// warnings fingerprint, exactly once, and is never sent again on its own. The job's timing rules, recovery at each
// step and the fixes' details are the module tests' (tdf-upload.test.ts, results.test.ts).

const OWNER = { username: 'organizer', password: 'correct horse' };
const TZ = 'America/Chicago';
const ENV = { TZ, NUXT_TOURNAMENT_DELAY_MS: '0', NUXT_STAFF_DELAY_MS: '500', NUXT_LOG_FORMAT: 'json' };
const GUID = '00000000-0000-4000-8000-0000000000d1';

const day = (days: number) => leagueDay(days, TZ);
const at18 = (date: string) => localInstant(date, '18:00', TZ).toISOString().replace('.000', '');
const DATE = day(-1);

let fake: FakePokemon;
let server: TestServer;
let browser: ReturnType<typeof client>;
let serial = 0;
let displayId: string;
const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
const post = (path: string, json: unknown) => api(path, { method: 'POST', json });
const body = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const code = async (res: Response) => (await body<{ data?: { code?: string } }>(res)).data?.code;
const results = (rest = '') => `/sessions/${DATE}/tournaments/${GUID}/results${rest}`;
const triumph = () => fake.requests.filter((r) => r.path.startsWith('/services/triumph/') && r.method !== 'GET');
const validates = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/services/triumph/tdf/');
const PLAYERS = [
  { userid: '1234567', first: 'Ash', last: 'Ketchum' },
  { userid: '2345678', first: 'Misty', last: 'Waterflower' },
];
const file = () => tomTdf({ players: PLAYERS, idElement: `<id>${displayId}</id>`, organizerElement: `<organizer popid="${FAKE_PLAYER_ID}" name="Olive Organizer"/>` });

interface Preview {
  uploadId: number;
  fingerprint: string;
  warnings: { code: string }[];
}
interface Job {
  status: string;
  kind: string;
  tournamentItems: { outcome: string }[];
  items: { playerId: string; outcome: string }[];
}

async function finished(res: Response): Promise<Job & { id: number }> {
  expect(res.status).toBe(202);
  const { submissionId } = await body<{ submissionId: number }>(res);
  for (const deadline = Date.now() + 25_000; Date.now() < deadline; ) {
    const job = await body<Job>(await api(`/submissions/${submissionId}`));
    if (job.status !== 'planned' && job.status !== 'running') return { ...job, id: submissionId };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job ${submissionId} did not finish`);
}

async function preview(content = file()): Promise<Preview> {
  const res = await post(results(), { filename: 'cup.tdf', content });
  expect(res.status).toBe(200);
  return body<Preview>(res);
}
const confirm = (p: Preview, fingerprint = p.fingerprint) => post(results(`/${p.uploadId}/confirm`), { importAttendance: true, acknowledgedWarnings: fingerprint });

async function login() {
  browser = client(server.url);
  expect((await browser.request('/api/auth/login', { method: 'POST', json: OWNER })).status).toBe(200);
}

beforeAll(async () => {
  fake = await startFakePokemon();
  server = await startServer({ env: { ...fake.env, ...ENV } });
  browser = client(server.url);
  const setup = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } });
  expect(setup.status).toBe(200);
  const start = await post('/pokemon/connect/start', {});
  const state = new URL((await body<{ authorizeUrl: string }>(start)).authorizeUrl).searchParams.get('state');
  expect((await post('/pokemon/connect/complete', { url: `https://play-tools.pokemon.com/loggedIn?code=fresh&state=${state}` })).status).toBe(200);
});
afterAll(async () => {
  // No token, no request body or file, and no birthdate in the logs.
  expect(server.logs()).not.toMatch(/ory_rt_|eyJ|<tournament|payload/);
  expect(server.logs()).not.toContain(BIRTHDATE);
  await server.dispose();
  await fake.close();
});
beforeEach(() => {
  fake.requests.length = 0;
  // A fresh tournament per test: uploads are play-tools' per display id.
  displayId = `26-10-9${String(++serial).padStart(5, '0')}`;
  fake.tournaments = [fakeTournament('d1', { startsAt: at18(DATE), displayId })];
  fake.tournaments[0]!.guid = GUID;
  fake.tournamentRecords.clear();
  fake.tournamentRecords.set(GUID, [fakeRecord(FAKE_PLAYER_ID, { role: 'organizer', first: 'Olive', last: 'Organizer' })]);
});

describe('auth and validation', () => {
  it.each([
    ['POST', '/results'],
    ['GET', '/results'],
    ['POST', '/results/1/organizer'],
    ['POST', '/results/1/recheck'],
    ['POST', '/results/1/remove-staff'],
    ['POST', '/results/1/confirm'],
  ])('%s …%s is 401 without a session, before validation or any upstream call', async (method, rest) => {
    const res = await fetch(`${server.url}/api/sessions/${DATE}/tournaments/${GUID}${rest}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    expect(res.status).toBe(401);
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ['a bad date', `/sessions/2026-02-30/tournaments/${GUID}/results`, { filename: 'a.tdf', content: 'x' }],
    ['a bad tournament id', `/sessions/${DATE}/tournaments/not-a-guid/results`, { filename: 'a.tdf', content: 'x' }],
    ['an unknown field', `/sessions/${DATE}/tournaments/${GUID}/results`, { filename: 'a.tdf', content: 'x', extra: 1 }],
    ['a bad upload id', `/sessions/${DATE}/tournaments/${GUID}/results/0/confirm`, { importAttendance: true, acknowledgedWarnings: 'a'.repeat(64) }],
    ['no fingerprint', `/sessions/${DATE}/tournaments/${GUID}/results/1/confirm`, { importAttendance: true }],
    ['no players to remove', `/sessions/${DATE}/tournaments/${GUID}/results/1/remove-staff`, { playerIds: [] }],
    ['an empty full name', `/sessions/${DATE}/tournaments/${GUID}/results/1/organizer`, { fullName: ' ' }],
  ])('is 400 for %s, with no upstream call', async (_label, path, json) => {
    expect((await post(path.replace('/api', ''), json)).status).toBe(400);
    expect(fake.requests).toEqual([]);
  });

  it('is 422 with the parser’s code for a file that is not a TDF, storing nothing', async () => {
    const res = await post(results(), { filename: 'a.tdf', content: 'not xml <' });
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('not_tdf');
  });

  it('is 404 for an upload of another date', async () => {
    const p = await preview();
    const res = await post(`/sessions/${day(-8)}/tournaments/${GUID}/results/${p.uploadId}/recheck`, {});
    expect(res.status).toBe(404);
  });
});

describe('the send', () => {
  it('previews reading only, then sends the file once and confirms once; processing is followed on read', async () => {
    const p = await preview();
    expect(p.warnings.map((w) => w.code)).toEqual(['tdf_unknown_players']);
    expect(fake.requests.filter((r) => r.method !== 'GET')).toEqual([]);

    const job = await finished(await confirm(p));
    expect(job).toMatchObject({ kind: 'tdf_upload', status: 'succeeded', tournamentItems: [{ outcome: 'processing' }] });
    expect(validates()).toEqual([expect.objectContaining({ body: { kind: 'tdf', tournament_id: displayId, payload: '<tdf>' } })]);
    expect(fake.validatedFiles.at(-1)).toBe(file());
    expect(triumph().filter((r) => r.method === 'PUT')).toEqual([expect.objectContaining({ body: { tournament_id: GUID } })]);

    // The job ended at the confirm, so the lease is free straight away: another job can start.
    expect((await finished(await post('/staff/import', {}))).kind).toBe('staff_import');

    fake.finishUpload(GUID, 'completed');
    const section = await body<{ upstream: { status: string }; latest: { state: string } }>(await api(results()));
    expect(section).toMatchObject({ upstream: { status: 'complete' }, latest: { state: 'complete' } });
    const history = await body<Job>(await api(`/submissions/${job.id}`));
    expect(history.tournamentItems[0]!.outcome).toBe('uploaded');
    expect(validates()).toHaveLength(1);
  });

  it('refuses a fingerprint that is not the preview’s, sending nothing', async () => {
    const p = await preview();
    const res = await confirm(p, 'a'.repeat(64));
    expect(res.status).toBe(422);
    const answer = await body<{ data: { code: string; fingerprint: string; warnings: unknown[] } }>(res);
    expect(answer.data).toMatchObject({ code: 'warnings_not_acknowledged', fingerprint: p.fingerprint });
    expect(triumph()).toEqual([]);
  });

  it('ends validate_unknown after a 503 on validate: one validate, no confirm', async () => {
    const p = await preview();
    fake.failOnce.set('/services/triumph/tdf/', 503);
    const job = await finished(await confirm(p));
    expect(job.tournamentItems[0]!.outcome).toBe('validate_unknown');
    expect(validates()).toHaveLength(1);
    expect(triumph().filter((r) => r.method === 'PUT')).toEqual([]);
    expect((await body<{ latest: { state: string } }>(await api(results()))).latest.state).toBe('validate_unknown');
  });

  it('keeps play-tools’ errors and does not confirm a file it does not accept', async () => {
    const p = await preview();
    fake.tdfErrors.set(displayId, [{ type: 'ORGANIZER_ID_MISMATCH', message: '1 !== 2' }]);
    const job = await finished(await confirm(p));
    expect(job.tournamentItems[0]!.outcome).toBe('not_accepted');
    expect(triumph().filter((r) => r.method === 'PUT')).toEqual([]);
  });
});

describe('Remove from staff', () => {
  it('refuses ids that are not removable, starting nothing', async () => {
    const p = await preview();
    const res = await post(results(`/${p.uploadId}/remove-staff`), { playerIds: ['5555555', FAKE_PLAYER_ID] });
    expect(res.status).toBe(422);
    expect((await body<{ data: { code: string; failures: unknown[] } }>(res)).data).toEqual({
      code: 'not_removable',
      failures: [
        { playerId: '5555555', reason: 'not_in_file' },
        { playerId: FAKE_PLAYER_ID, reason: 'not_in_file' },
      ],
    });
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
  });

  it('removes a judge who played, even one added in play-tools, then the preview no longer warns', async () => {
    fake.tournamentRecords.get(GUID)!.push(fakeRecord('1234567', { role: 'judge', first: 'Ash', last: 'Ketchum' }));
    const p = await preview();
    expect(p.warnings.map((w) => w.code)).toContain('tdf_staff_also_playing');

    const job = await finished(await post(results(`/${p.uploadId}/remove-staff`), { playerIds: ['1234567'] }));
    expect(job).toMatchObject({ kind: 'staff', status: 'succeeded', items: [expect.objectContaining({ playerId: '1234567', outcome: 'removed' })] });
    expect(fake.requests.filter((r) => r.method === 'DELETE')).toEqual([expect.objectContaining({ path: `/services/core/tournaments/${GUID}/records/rec-1234567` })]);

    const again = await body<Preview>(await post(results(`/${p.uploadId}/recheck`), {}));
    expect(again.warnings.map((w) => w.code)).not.toContain('tdf_staff_also_playing');
    expect(triumph()).toEqual([]);
  });
});

describe('never sent again on its own', () => {
  it('a restart mid-validate ends validate_unknown, sends nothing on boot, and History offers no retry', async () => {
    const p = await preview();
    const hold = fake.holdValidates();
    const res = await confirm(p);
    expect(res.status).toBe(202);
    const { submissionId } = await body<{ submissionId: number }>(res);
    await hold.arrived;

    await server.kill();
    hold.release();
    fake.requests.length = 0;
    server = await startServer({ env: { ...fake.env, ...ENV }, dataDir: server.dataDir });
    await login();

    const job = await body<Job>(await api(`/submissions/${submissionId}`));
    expect(job).toMatchObject({ status: 'interrupted', tournamentItems: [{ outcome: 'validate_unknown' }] });
    expect(triumph()).toEqual([]);
    const retry = await post(`/submissions/${submissionId}/retry`, {});
    expect(retry.status).toBe(422);
    expect(await code(retry)).toBe('use_upload_again');
    expect(triumph()).toEqual([]);
  });
});
