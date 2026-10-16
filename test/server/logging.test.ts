import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_PLAYER_ID, FAKE_SUB, type FakePlaySession, type FakePokemon, fakeRecord, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, logRecords, runToExit, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse battery' };
const AUTH_CODE = 'authcode-7Qx9';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
const ENV = { TZ: 'America/Chicago', NUXT_SUBMISSION_BATCH_DELAY_MS: '0' };
const PRETTY_LINE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] (TRACE|DEBUG|INFO|WARN|ERROR|FATAL): \[[a-z-]+\] /;

type Browser = ReturnType<typeof client>;

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

async function signUp(server: TestServer): Promise<Browser> {
  const browser = client(server.url);
  const res = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } });
  expect(res.status).toBe(200);
  return browser;
}

async function connect(browser: Browser, headers: Record<string, string> = {}) {
  const start = await browser.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL(((await start.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state');
  const res = await browser.request('/api/pokemon/connect/complete', {
    method: 'POST',
    headers,
    json: { url: `https://play-tools.pokemon.com/loggedIn?code=${AUTH_CODE}&state=${state}` },
  });
  expect(res.status).toBe(200);
}

async function waitFor<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const found = probe();
    if (found !== undefined) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('request ids', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer({ env: { NUXT_LOG_FORMAT: 'json' } });
  });
  afterAll(() => server.dispose());

  it('generates a UUID when the client sends none', async () => {
    const res = await fetch(`${server.url}/healthz`);
    expect(res.headers.get('x-request-id')).toMatch(UUID);
  });

  it('echoes a well-formed incoming id', async () => {
    const res = await fetch(`${server.url}/healthz`, { headers: { 'x-request-id': 'abc-123.x:y_z' } });
    expect(res.headers.get('x-request-id')).toBe('abc-123.x:y_z');
  });

  it.each([
    ['65 characters', `rejected${'A'.repeat(57)}`],
    ['a space', 'rejected id'],
    ['unicode', 'rejected-résumé'],
  ])('replaces an id with %s by a fresh UUID and never logs it', async (_, id) => {
    const res = await fetch(`${server.url}/api/auth/setup`, { headers: { 'x-request-id': id } });
    expect(res.headers.get('x-request-id')).toMatch(UUID);
    await new Promise((r) => setTimeout(r, 100));
    expect(server.logs()).not.toContain('rejected');
  });

  it('replaces an empty id by a fresh UUID', async () => {
    const res = await fetch(`${server.url}/healthz`, { headers: { 'x-request-id': '' } });
    expect(res.headers.get('x-request-id')).toMatch(UUID);
  });

  it.each([
    ['401 without a session', '/api/players', {}],
    ['415 for a body that is not JSON', '/api/regulars', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } }],
    ['a page', '/', {}],
    ['readiness', '/readyz', {}],
  ] as const)('is on every response: %s', async (_, path, init) => {
    const res = await fetch(`${server.url}${path}`, init as RequestInit);
    expect(res.headers.get('x-request-id')).toMatch(UUID);
  });
});

describe('the request log', () => {
  let server: TestServer;
  let browser: Browser;
  beforeAll(async () => {
    server = await startServer({ env: { NUXT_LOG_FORMAT: 'json', NUXT_LOG_LEVEL: 'info' } });
    browser = await signUp(server);
  });
  afterAll(() => server.dispose());

  it('writes one http record per request: method, path without the query, status, duration and id', async () => {
    const res = await browser.request('/api/players?q=secret-query', { headers: { 'x-request-id': 'req-http-1' } });
    expect(res.status).toBe(200);

    const record = await waitFor(() => logRecords(server.logs()).find((r) => r.scope === 'http' && r.reqId === 'req-http-1'), 'the http record');
    expect(record).toMatchObject({ level: 30, method: 'GET', path: '/api/players', status: 200, reqId: 'req-http-1' });
    expect(record.msg).toMatch(/^GET \/api\/players 200 \d+ms$/);
    expect(record.durationMs).toEqual(expect.any(Number));
    expect(server.logs()).not.toContain('secret-query');
  });

  it('keeps health checks out of the log at info', async () => {
    await fetch(`${server.url}/healthz`, { headers: { 'x-request-id': 'req-health-info' } });
    await new Promise((r) => setTimeout(r, 200));
    expect(server.logs()).not.toContain('req-health-info');
  });

  it('returns the id on a 404 too', async () => {
    const res = await browser.request('/api/submissions/999', { headers: { 'x-request-id': 'req-404-header' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('x-request-id')).toBe('req-404-header');
  });

  it('logs a 4xx error as a warning without a stack', async () => {
    await browser.request('/api/submissions/999', { headers: { 'x-request-id': 'req-404' } });
    const record = await waitFor(
      () => logRecords(server.logs()).find((r) => r.reqId === 'req-404' && r.level === 40),
      'the error record',
    );
    expect(record).toMatchObject({ level: 40, scope: 'http', path: '/api/submissions/999', statusCode: 404 });
    expect(JSON.stringify(record)).not.toContain('"stack"');
  });

  it('logs nothing about the setup code request beyond its http line', async () => {
    const before = logRecords(server.logs()).length;
    await fetch(`${server.url}/api/auth/setup`, { headers: { 'x-request-id': 'req-setup' } });
    await waitFor(() => logRecords(server.logs()).find((r) => r.reqId === 'req-setup'), 'the setup http record');
    const added = logRecords(server.logs()).slice(before).filter((r) => r.reqId === 'req-setup');
    expect(added.map((r) => r.scope)).toEqual(['http']);
  });
});

describe('health checks at debug', () => {
  it('are logged at debug', async () => {
    const server = await startServer({ env: { NUXT_LOG_FORMAT: 'json', NUXT_LOG_LEVEL: 'debug' } });
    try {
      await fetch(`${server.url}/healthz`, { headers: { 'x-request-id': 'req-health-debug' } });
      const record = await waitFor(() => logRecords(server.logs()).find((r) => r.reqId === 'req-health-debug'), 'the healthz record');
      expect(record).toMatchObject({ level: 20, scope: 'http', path: '/healthz' });
    } finally {
      await server.dispose();
    }
  });
});

describe('request ids follow the work they start', () => {
  let server: TestServer;
  let browser: Browser;
  beforeAll(async () => {
    fake.playSessions = [SESSION];
    fake.records.set(PS, []);
    server = await startServer({ env: { ...fake.env, ...ENV, NUXT_LOG_FORMAT: 'json' } });
    browser = await signUp(server);
    // The connect identifies the professor, then discovers leagues; discovery fails and is logged with the request's id.
    fake.failOnce.set(`/services/core/users/${FAKE_SUB}/activity_groups/`, { status: 503, after: 1 });
    await connect(browser, { 'x-request-id': 'req-module-1' });
    // From here on discovery meets a shape this version does not understand: a 5xx.
    fake.leagues = [{ guid: 'group-1', display_id: 12345 as never, display_name: 'Card Shop', canSubmit: true }];
  });
  afterAll(async () => {
    fake.leagues = [{ guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true }];
    await server.dispose();
  });

  it('tags module and adapter logs with the request that caused them', async () => {
    await waitFor(() => logRecords(server.logs()).find((r) => r.reqId === 'req-module-1' && r.scope === 'http'), 'the connect request line');
    const tagged = logRecords(server.logs()).filter((r) => r.reqId === 'req-module-1');
    expect(tagged.map((r) => r.scope)).toEqual(expect.arrayContaining(['pokemon', 'http']));
    expect(tagged.find((r) => r.scope === 'pokemon' && /League discovery/.test(String(r.msg)))).toMatchObject({ level: 40 });
  });

  it('logs an unhandled 5xx as an error with its stack, and the adapter outline under the same id', async () => {
    const res = await browser.request(`/api/leagues/upstream?professor=${FAKE_PLAYER_ID}`, { headers: { 'x-request-id': 'req-502' } });
    expect(res.status).toBe(502);
    expect(res.headers.get('x-request-id')).toBe('req-502');
    const record = await waitFor(
      () => logRecords(server.logs()).find((r) => r.reqId === 'req-502' && r.scope === 'http' && r.level === 50),
      'the 5xx error record',
    );
    expect(record).toMatchObject({ path: expect.stringMatching(/^\/api\/leagues\/upstream/), statusCode: 502, err: { stack: expect.any(String) } });
    const outline = logRecords(server.logs()).find((r) => r.reqId === 'req-502' && r.scope === 'pokemon' && /wire contract/.test(String(r.msg)));
    expect(outline).toMatchObject({ keys: expect.any(Array) });
  });

  it('keeps the request id on a submission job after the response, and on a retry, and returns it on the SSE stream', async () => {
    fake.leagues = [{ guid: 'group-1', display_id: 'L5012', display_name: 'Card Shop', canSubmit: true }];
    await browser.request('/api/settings', { method: 'PUT', json: { professorPlayerId: FAKE_PLAYER_ID, activityGroupId: 'group-1' } });
    await browser.request(`/api/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '1', name: 'A' } });

    const started = await browser.request(`/api/sessions/${TUESDAY}/submissions`, {
      method: 'POST',
      headers: { 'x-request-id': 'req-job-1' },
      json: { playSessionId: PS },
    });
    expect(started.status).toBe(202);
    const { submissionId } = (await started.json()) as { submissionId: number };

    const done = await waitFor(
      () => logRecords(server.logs()).find((r) => r.scope === 'submission' && r.submissionId === submissionId && r.status),
      'the job to finish',
    );
    expect(done.reqId).toBe('req-job-1');
    const jobRecords = logRecords(server.logs()).filter((r) => r.scope === 'submission' && r.submissionId === submissionId);
    expect(jobRecords.length).toBeGreaterThanOrEqual(2);
    for (const r of jobRecords) expect(r.reqId).toBe('req-job-1');

    const events = await browser.request(`/api/submissions/${submissionId}/events`, { headers: { 'x-request-id': 'req-sse' } });
    expect(events.headers.get('x-request-id')).toBe('req-sse');
    await events.text();

    const retried = await browser.request(`/api/submissions/${submissionId}/retry`, {
      method: 'POST',
      headers: { 'x-request-id': 'req-retry-1' },
      json: {},
    });
    const retryId = ((await retried.json()) as { submissionId: number }).submissionId;
    const retryDone = await waitFor(
      () => logRecords(server.logs()).find((r) => r.scope === 'submission' && r.submissionId === retryId && r.status),
      'the retry to finish',
    );
    expect(retryDone.reqId).toBe('req-retry-1');
  });

  it('still logs a request the client walked away from, marked aborted', async () => {
    fake.bulkDelayMs = 1_000;
    await browser.request(`/api/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '2', name: 'B' } });
    const started = await browser.request(`/api/sessions/${TUESDAY}/submissions`, { method: 'POST', json: { playSessionId: PS } });
    const { submissionId } = (await started.json()) as { submissionId: number };

    const abort = new AbortController();
    const stream = await browser.request(`/api/submissions/${submissionId}/events`, {
      headers: { 'x-request-id': 'req-aborted' },
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    abort.abort();

    const record = await waitFor(
      () => logRecords(server.logs()).find((r) => r.reqId === 'req-aborted' && r.scope === 'http'),
      'the aborted request line',
    );
    expect(record).toMatchObject({ aborted: true, path: `/api/submissions/${submissionId}/events` });
    fake.bulkDelayMs = 0;
    await waitFor(
      () => logRecords(server.logs()).find((r) => r.scope === 'submission' && r.submissionId === submissionId && r.status),
      'the job to finish',
    );
  });

  it('never mixes up the ids of concurrent requests', async () => {
    fake.bulkDelayMs = 0;
    const ids = Array.from({ length: 10 }, (_, i) => `req-concurrent-${i}`);
    await Promise.all(ids.map((id) => browser.request(`/api/leagues/upstream?professor=${FAKE_PLAYER_ID}`, { headers: { 'x-request-id': id } })));
    for (const id of ids) await server.waitForLog(new RegExp(`"scope":"http".*"reqId":"${id}"|"reqId":"${id}".*"scope":"http"`));
    for (const id of ids) {
      const mine = logRecords(server.logs()).filter((r) => r.reqId === id);
      expect(mine.filter((r) => r.scope === 'http')).toHaveLength(1);
    }
  });
});

describe('work no request started', () => {
  it('logs boot recovery without a request id', async () => {
    fake.playSessions = [SESSION];
    fake.records.set(PS, []);
    const env = { ...fake.env, ...ENV, NUXT_LOG_FORMAT: 'json', NUXT_SUBMISSION_BATCH_SIZE: '1' };
    const first = await startServer({ env });
    const browser = await signUp(first);
    await connect(browser);
    await browser.request(`/api/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '1', name: 'A' } });
    await browser.request(`/api/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '2', name: 'B' } });
    fake.bulkDelayMs = 1_500;
    await browser.request(`/api/sessions/${TUESDAY}/submissions`, { method: 'POST', json: { playSessionId: PS } });
    await new Promise((r) => setTimeout(r, 500));
    // Kill without a graceful stop, so the job is still `running` in the database.
    await first.kill();
    fake.bulkDelayMs = 0;

    const second = await startServer({ env, dataDir: first.dataDir });
    try {
      await second.waitForLog(/interrupted by a restart/);
      const recovery = logRecords(second.logs()).find((r) => /interrupted by a restart/.test(String(r.msg)));
      expect(recovery).toMatchObject({ scope: 'submission', level: 40 });
      expect(recovery).not.toHaveProperty('reqId');
    } finally {
      await second.dispose();
    }
  });
});

describe('readable by default', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startServer();
    await server.setupCode();
    await fetch(`${server.url}/api/players`, { headers: { 'x-request-id': 'req-pretty-1' } });
    await server.waitForLog(/INFO: \[http\] .*req-pretty-1/);
  });
  afterAll(() => server.dispose());

  it('prints the setup code on one exact, findable line', () => {
    const line = server.logs().split('\n').find((l) => l.includes('setup code'));
    expect(line).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] INFO: \[setup\] No organizer account yet\. Open the app and enter this setup code: [A-Z2-9]{4}-[A-Z2-9]{4}$/,
    );
    expect(server.logs()).toMatch(/enter this setup code: ([A-Z2-9]{4}-[A-Z2-9]{4})/);
  });

  it('prints the request line as method, path, status and duration, then the id', () => {
    const line = server.logs().split('\n').find((l) => l.includes('req-pretty-1') && l.includes('INFO: [http]'));
    expect(line).toMatch(/^\[[^\]]+\] INFO: \[http\] GET \/api\/players 401 \d+ms \{"reqId":"req-pretty-1"\}$/);
  });

  it('writes only readable lines: no JSON records, nothing but log lines, stack lines and the listen banner', () => {
    const lines = server.logs().split('\n').filter((l) => l !== '');
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(line.startsWith('{"level"')).toBe(false);
      expect(PRETTY_LINE.test(line) || /^ {4}\S/.test(line) || /Listening on/.test(line)).toBe(true);
    }
  });

  it('prints the setup code as a JSON record in json format', async () => {
    const json = await startServer({ env: { NUXT_LOG_FORMAT: 'json' } });
    try {
      await json.setupCode();
      const record = logRecords(json.logs()).find((r) => r.scope === 'setup');
      expect(record).toMatchObject({ level: 30 });
      expect(record!.msg).toMatch(/^No organizer account yet\. Open the app and enter this setup code: [A-Z2-9]{4}-[A-Z2-9]{4}$/);
    } finally {
      await json.dispose();
    }
  });
});

describe('a startup failure', () => {
  it('is one readable startup error line, without the bad value', async () => {
    const { code, output } = await runToExit({ NUXT_TOKEN_VAULT_KEY: 'not-a-valid-key-value' });
    expect(code).toBe(1);
    expect(output).toMatch(/^\[[^\]]+\] ERROR: \[startup\] .*NUXT_TOKEN_VAULT_KEY/m);
    expect(output).not.toContain('not-a-valid-key-value');
  });
});

describe('no secret reaches the log', () => {
  it.each(['pretty', 'json'])('in %s format, at trace, through connect, refresh and a submission', async (format) => {
    fake.playSessions = [SESSION];
    fake.records.set(PS, [fakeRecord('77', { first: 'Ashley', last: 'Ketchum' })]);
    fake.accessTtl = 60; // every use refreshes, rotating the refresh token
    const server = await startServer({ env: { ...fake.env, ...ENV, NUXT_LOG_FORMAT: format, NUXT_LOG_LEVEL: 'trace' } });
    try {
      const browser = await signUp(server);
      await connect(browser);
      await browser.request(`/api/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '1', name: 'Misty Waterflower' } });
      const res = await browser.request(`/api/sessions/${TUESDAY}/submissions`, { method: 'POST', json: { playSessionId: PS } });
      const { submissionId } = (await res.json()) as { submissionId: number };
      for (let i = 0; i < 100; i++) {
        const view = (await (await browser.request(`/api/submissions/${submissionId}`)).json()) as { status: string };
        if (!['planned', 'running'].includes(view.status)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 200));

      const logs = server.logs();
      const cookie = browser.cookie.split('=').slice(1).join('=');
      const secrets = [
        fake.liveAccessToken()!,
        fake.liveRefreshToken()!,
        ...fake.requests.flatMap((r) => (r.form?.refresh_token ? [r.form.refresh_token] : [])),
        AUTH_CODE,
        cookie,
        OWNER.password,
        'Ashley',
        'Ketchum',
        'Misty',
      ];
      for (const secret of secrets) {
        expect(secret.length).toBeGreaterThan(3);
        expect(logs).not.toContain(secret);
      }
    } finally {
      fake.accessTtl = 3599;
      await server.dispose();
    }
  });
});

describe('logging overhead', () => {
  it('adds under 1 ms to the median request', async () => {
    const timeHealthz = async (server: TestServer) => {
      for (let i = 0; i < 20; i++) await fetch(`${server.url}/healthz`);
      const times: number[] = [];
      for (let i = 0; i < 200; i++) {
        const start = performance.now();
        await (await fetch(`${server.url}/healthz`)).text();
        times.push(performance.now() - start);
      }
      return median(times);
    };
    const silent = await startServer({ env: { NUXT_LOG_LEVEL: 'silent' } });
    const debug = await startServer({ env: { NUXT_LOG_LEVEL: 'debug' } });
    try {
      const [quiet, loud] = [await timeHealthz(silent), await timeHealthz(debug)];
      expect(loud - quiet).toBeLessThan(1);
    } finally {
      await silent.dispose();
      await debug.dispose();
    }
  });
});
