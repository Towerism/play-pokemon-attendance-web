import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakePokemon, type FakePlaySession, fakeRecord, startFakePokemon } from './fake-pokemon';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };
// A Tuesday; its evening session starts on Wednesday in UTC (S3), so the date must be read in the league TZ.
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

let fake: FakePokemon;
beforeAll(async () => {
  fake = await startFakePokemon();
});
afterAll(() => fake.close());

type Browser = ReturnType<typeof client>;
const ENV = { TZ: 'America/Chicago', NUXT_SUBMISSION_BATCH_DELAY_MS: '0', NUXT_UNDO_DELAY_MS: '0' };

async function login(server: TestServer, setup: boolean): Promise<Browser> {
  const browser = client(server.url);
  const res = setup
    ? await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: setupCodeFrom(server.logs()), ...OWNER } })
    : await browser.request('/api/auth/login', { method: 'POST', json: OWNER });
  expect(res.status).toBe(200);
  return browser;
}

async function connect(browser: Browser) {
  const start = await browser.request('/api/pokemon/connect/start', { method: 'POST', json: {} });
  const state = new URL(((await start.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get('state');
  const res = await browser.request('/api/pokemon/connect/complete', {
    method: 'POST',
    json: { url: `https://play-tools.pokemon.com/loggedIn?code=fresh&state=${state}` },
  });
  expect(res.status).toBe(200);
}

const upstreamIds = () => (fake.records.get(PS) ?? []).map((r) => r.participant.player_id).sort();
const bulkCalls = () => fake.requests.filter((r) => r.path.endsWith('/_bulk/'));

describe('submission API', () => {
  let server: TestServer;
  let browser: Browser;
  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);

  async function finished(submissionId: number) {
    for (let i = 0; i < 100; i++) {
      const view = await (await api(`/submissions/${submissionId}`)).json();
      if (!['planned', 'running'].includes(view.status)) return view;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('submission did not finish');
  }

  async function submit(): Promise<number> {
    const res = await api(`/sessions/${TUESDAY}/submissions`, { method: 'POST', json: { playSessionId: PS } });
    expect(res.status).toBe(202);
    return ((await res.json()) as { submissionId: number }).submissionId;
  }

  beforeEach(async () => {
    fake.requests.length = 0;
    fake.playSessions = [SESSION];
    fake.records = new Map([[PS, [fakeRecord('9999991', { role: 'organizer' })]]]);
    fake.bulkDelayMs = 0;
    server = await startServer({ env: { ...fake.env, ...ENV } });
    browser = await login(server, true);
  });
  afterEach(async () => {
    expect(server.logs()).not.toMatch(/ory_rt_|eyJ/);
    await server.dispose();
  });

  describe('auth', () => {
    it.each([
      ['POST', `/api/sessions/${TUESDAY}/resolve`],
      ['POST', `/api/sessions/${TUESDAY}/submissions`],
      ['GET', '/api/submissions'],
      ['GET', '/api/submissions/1'],
      ['GET', '/api/submissions/1/events'],
      ['POST', '/api/submissions/1/retry'],
      ['POST', '/api/submissions/1/undo'],
    ])('%s %s is 401 without a session, before any validation or upstream call', async (method, path) => {
      const res = await client(server.url).request(path, { method, json: method === 'POST' ? {} : undefined });
      expect(res.status).toBe(401);
      expect(fake.requests).toEqual([]);
    });
  });

  describe('POST /sessions/{date}/resolve', () => {
    it('is 409 not_connected before a Pokémon account is connected', async () => {
      const res = await api(`/sessions/${TUESDAY}/resolve`, { method: 'POST', json: {} });
      expect(res.status).toBe(409);
      expect((await res.json()).data).toEqual({ code: 'not_connected' });
    });

    it("lists the date's play sessions in the league timezone, labelled", async () => {
      await connect(browser);
      const res = await api(`/sessions/${TUESDAY}/resolve`, { method: 'POST', json: {} });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        timeZone: 'America/Chicago',
        candidates: [
          {
            id: PS,
            label: 'Open play · TCG · Tue 6:00 PM',
            status: 'active',
            startsAt: '2026-10-13T23:00:00.000Z',
            endsAt: '2026-10-14T02:00:00.000Z',
            editableUntil: '2099-01-01T00:00:00.000Z',
            editable: true,
          },
        ],
      });
    });

    it('lists nothing for a date with no session (the evening session is not on Wednesday)', async () => {
      await connect(browser);
      const res = await api('/sessions/2026-10-14/resolve', { method: 'POST', json: {} });
      expect((await res.json()).candidates).toEqual([]);
    });

    it('is 400 for a date that is not a date', async () => {
      expect((await api('/sessions/2026-02-30/resolve', { method: 'POST', json: {} })).status).toBe(400);
    });
  });

  describe('POST /sessions/{date}/submissions', () => {
    beforeEach(async () => {
      await connect(browser);
      await api('/regulars', { method: 'POST', json: { playerId: '9999991', name: 'The Organizer' } });
      await api('/regulars', { method: 'POST', json: { playerId: '0012345', name: 'Ash Ketchum' } });
      await api(`/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '4242', name: 'Misty' } });
    });

    it('adds who play-tools is missing, in the background, and records each outcome', async () => {
      const view = await finished(await submit());

      expect(view).toMatchObject({
        date: TUESDAY,
        playSessionId: PS,
        status: 'succeeded',
        counts: { added: 2, alreadyPresent: 1, failed: 0, skipped: 0, unrequested: 0 },
      });
      expect(view.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ playerId: '4242', displayName: 'Misty', origin: 'session', outcome: 'added' }),
          expect.objectContaining({ playerId: '0012345', origin: 'regular', outcome: 'added' }),
          expect.objectContaining({ playerId: '9999991', outcome: 'already_present', asStaff: true }),
        ]),
      );
      expect(upstreamIds()).toEqual(['0012345', '4242', '9999991']);
      expect(bulkCalls()).toHaveLength(1);
      expect((await (await api(`/sessions/${TUESDAY}`)).json())).toMatchObject({ status: 'submitted', playSessionId: PS });
    });

    it('is safe to click twice: the second run sends nothing', async () => {
      await finished(await submit());
      fake.requests.length = 0;

      const again = await finished(await submit());

      expect(again.counts).toMatchObject({ added: 0, alreadyPresent: 3 });
      expect(bulkCalls()).toEqual([]);
    });

    it.each([
      ['missing', {}],
      ['empty', { playSessionId: '' }],
      ['not a string', { playSessionId: 42 }],
    ])('is 400 when playSessionId is %s', async (_label, json) => {
      expect((await api(`/sessions/${TUESDAY}/submissions`, { method: 'POST', json })).status).toBe(400);
    });

    it("is 422 unknown_play_session for a session that is not that date's", async () => {
      const res = await api(`/sessions/${TUESDAY}/submissions`, { method: 'POST', json: { playSessionId: 'someone-elses' } });
      expect(res.status).toBe(422);
      expect((await res.json()).data).toEqual({ code: 'unknown_play_session' });
      expect(bulkCalls()).toEqual([]);
    });

    it('is 422 edit_window_closed once play-tools no longer accepts attendance', async () => {
      fake.playSessions = [{ ...SESSION, final_modifiable_datetime: '2020-01-01T00:00:00Z' }];
      const res = await api(`/sessions/${TUESDAY}/submissions`, { method: 'POST', json: { playSessionId: PS } });
      expect(res.status).toBe(422);
      expect((await res.json()).data).toEqual({ code: 'edit_window_closed' });
    });

    it('is 422 nothing_to_submit with no regulars and no session players', async () => {
      await api('/regulars/9999991', { method: 'DELETE' });
      await api('/regulars/0012345', { method: 'DELETE' });
      fake.playSessions = [{ ...SESSION, guid: 'ps-other', start_date: '2026-10-20T23:00:00Z' }];
      const res = await api('/sessions/2026-10-20/submissions', { method: 'POST', json: { playSessionId: 'ps-other' } });
      expect(res.status).toBe(422);
      expect((await res.json()).data).toEqual({ code: 'nothing_to_submit' });
    });

    it('is 409 submission_running while one is in flight', async () => {
      fake.bulkDelayMs = 1_000;
      await submit();
      const res = await api(`/sessions/${TUESDAY}/submissions`, { method: 'POST', json: { playSessionId: PS } });
      expect(res.status).toBe(409);
      expect((await res.json()).data).toEqual({ code: 'submission_running' });
    });

    it('is 409 league_not_selected when the account has several leagues and none is chosen', async () => {
      fake.leagues.push({ guid: 'group-2', display_id: 'L7000', display_name: 'Game Den', canSubmit: true });
      try {
        await api('/pokemon/connection', { method: 'DELETE' });
        await connect(browser);
        const res = await api(`/sessions/${TUESDAY}/resolve`, { method: 'POST', json: {} });
        expect(res.status).toBe(409);
        expect((await res.json()).data).toEqual({ code: 'league_not_selected' });
      } finally {
        fake.leagues.pop();
      }
    });
  });

  describe('progress, history and retry', () => {
    beforeEach(async () => {
      await connect(browser);
      await api(`/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '4242', name: 'Misty' } });
    });

    it('GET /submissions/{id}/events replays the persisted progress as server-sent events, then ends', async () => {
      const id = await submit();
      await finished(id);

      const res = await api(`/submissions/${id}/events`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const events = parseSse(await res.text());
      expect(events.map((e) => e.event)).toEqual(['planned', 'batch_sent', 'reconciled', 'finished']);
      expect(JSON.parse(events.at(-1)!.data)).toMatchObject({ type: 'finished', done: 1, total: 1, status: 'succeeded' });

      const resumed = await api(`/submissions/${id}/events`, { headers: { 'last-event-id': events[1]!.id } });
      expect(parseSse(await resumed.text()).map((e) => e.event)).toEqual(['reconciled', 'finished']);
    });

    it('streams events live while the job runs', async () => {
      fake.bulkDelayMs = 300;
      const id = await submit();
      const res = await api(`/submissions/${id}/events`);
      expect(parseSse(await res.text()).map((e) => e.event)).toEqual(['planned', 'batch_sent', 'reconciled', 'finished']);
    });

    it('GET /submissions lists newest first, filtered by date; 400 for a bad date', async () => {
      const first = await submit();
      await finished(first);
      const second = await submit();
      await finished(second);

      const list = await (await api(`/submissions?date=${TUESDAY}`)).json();
      expect(list.submissions.map((s: { id: number }) => s.id)).toEqual([second, first]);
      expect((await (await api('/submissions?date=2026-10-20')).json()).submissions).toEqual([]);
      expect((await api('/submissions?date=yesterday')).status).toBe(400);
    });

    it('POST /submissions/{id}/retry starts a new attempt that plans again', async () => {
      const id = await submit();
      await finished(id);
      fake.records.set(PS, [fakeRecord('9999991', { role: 'organizer' })]); // someone undid it upstream

      const res = await api(`/submissions/${id}/retry`, { method: 'POST', json: {} });
      expect(res.status).toBe(202);
      const { submissionId } = await res.json();
      expect(submissionId).not.toBe(id);
      expect(await finished(submissionId)).toMatchObject({ retryOf: id, status: 'succeeded', counts: { added: 1 } });
    });

    it.each([
      ['GET', '/submissions/999'],
      ['GET', '/submissions/999/events'],
      ['POST', '/submissions/999/retry'],
    ])('%s %s is 404', async (method, path) => {
      const res = await api(path, { method, json: method === 'POST' ? {} : undefined });
      expect(res.status).toBe(404);
      expect((await res.json()).data).toEqual({ code: 'not_found' });
    });

    it.each(['abc', '0', '-1', '1.5'])('GET /submissions/%s is 400', async (id) => {
      expect((await api(`/submissions/${id}`)).status).toBe(400);
    });
  });

  describe('POST /submissions/{id}/undo', () => {
    const deletes = () => fake.requests.filter((r) => r.method === 'DELETE');
    beforeEach(async () => {
      await connect(browser);
      await api('/regulars', { method: 'POST', json: { playerId: '0012345', name: 'Ash Ketchum' } });
      await api(`/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '4242', name: 'Misty' } });
    });

    async function undo(id: number): Promise<number> {
      const res = await api(`/submissions/${id}/undo`, { method: 'POST' });
      expect(res.status).toBe(202);
      return ((await res.json()) as { submissionId: number }).submissionId;
    }

    it('removes only the records the submission added, in the background, and takes undone session players off the date', async () => {
      const id = await submit();
      await finished(id);
      fake.records.get(PS)!.push(fakeRecord('777', { guid: 'walk-in' })); // entered in play-tools directly
      fake.requests.length = 0;

      const undoId = await undo(id);
      const view = await finished(undoId);

      expect(view).toMatchObject({ kind: 'undo', undoOf: id, status: 'succeeded', undoable: false, undoBlockedReason: 'not_undoable' });
      expect(view.items.map((i: { playerId: string; outcome: string }) => [i.playerId, i.outcome]).sort()).toEqual([
        ['0012345', 'removed'],
        ['4242', 'removed'],
      ]);
      expect(deletes()).toHaveLength(2);
      expect(upstreamIds()).toEqual(['777', '9999991']);
      const draft = await (await api(`/sessions/${TUESDAY}`)).json();
      expect(draft.players).toEqual([]);
      expect(draft.regulars).toEqual([expect.objectContaining({ playerId: '0012345', present: false })]);
      expect(draft.status).toBe('submitted');

      const original = await (await api(`/submissions/${id}`)).json();
      expect(original).toMatchObject({ undoable: false, undoBlockedReason: 'nothing_to_undo' });
      expect(original.items.find((i: { playerId: string }) => i.playerId === '4242').removedBy).toBe(undoId);
      const list = (await (await api('/submissions')).json()).submissions;
      expect(list[0]).toMatchObject({ id: undoId, kind: 'undo', undoOf: id });
    });

    it('streams its progress like a submission', async () => {
      const id = await submit();
      await finished(id);
      const undoId = await undo(id);

      const events = parseSse(await (await api(`/submissions/${undoId}/events`)).text());

      expect(events.map((e) => e.event)).toEqual(['planned', 'record_removed', 'record_removed', 'reconciled', 'finished']);
      expect(JSON.parse(events.at(-1)!.data)).toMatchObject({ status: 'succeeded' });
    });

    it('keeps deletes at least 500 ms apart even when NUXT_UNDO_DELAY_MS asks for less', async () => {
      const id = await submit();
      await finished(id);
      fake.requests.length = 0;

      await finished(await undo(id));

      const [first, second] = deletes();
      expect(second!.at! - first!.at!).toBeGreaterThanOrEqual(500);
    });

    it('is 422 nothing_to_undo the second time, and 422 not_undoable for an undo', async () => {
      const id = await submit();
      await finished(id);
      const undoId = await undo(id);
      await finished(undoId);

      const again = await api(`/submissions/${id}/undo`, { method: 'POST' });
      expect(again.status).toBe(422);
      expect((await again.json()).data).toEqual({ code: 'nothing_to_undo' });
      const ofUndo = await api(`/submissions/${undoId}/undo`, { method: 'POST' });
      expect(ofUndo.status).toBe(422);
      expect((await ofUndo.json()).data).toEqual({ code: 'not_undoable' });
    });

    it('is 409 submission_running while a job runs for the league', async () => {
      const id = await submit();
      await finished(id);
      fake.bulkDelayMs = 1_000;
      await api(`/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '5151', name: 'Brock' } });
      await submit();

      const res = await api(`/submissions/${id}/undo`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect((await res.json()).data).toEqual({ code: 'submission_running' });
    });

    it('is 422 edit_window_closed once play-tools no longer accepts attendance', async () => {
      const closesAt = Date.now() + 2_000;
      fake.playSessions = [{ ...SESSION, final_modifiable_datetime: new Date(closesAt).toISOString() }];
      const id = await submit();
      await finished(id);
      await new Promise((r) => setTimeout(r, closesAt - Date.now() + 50));

      const res = await api(`/submissions/${id}/undo`, { method: 'POST' });
      expect(res.status).toBe(422);
      expect((await res.json()).data).toEqual({ code: 'edit_window_closed' });
      expect(deletes()).toEqual([]);
    });

    it('is 404 for an unknown submission and 400 for an id that is not one', async () => {
      const res = await api('/submissions/999/undo', { method: 'POST' });
      expect(res.status).toBe(404);
      expect((await res.json()).data).toEqual({ code: 'not_found' });
      expect((await api('/submissions/abc/undo', { method: 'POST' })).status).toBe(400);
    });
  });

  it('stops between batches on shutdown, comes back interrupted, and resumes', async () => {
    await server.dispose();
    server = await startServer({ env: { ...fake.env, ...ENV, NUXT_SUBMISSION_BATCH_SIZE: '1' } });
    browser = await login(server, true);
    await connect(browser);
    await api(`/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '1', name: 'A' } });
    await api(`/sessions/${TUESDAY}/players`, { method: 'POST', json: { playerId: '2', name: 'B' } });
    fake.bulkDelayMs = 1_500;

    const id = await submit();
    await new Promise((r) => setTimeout(r, 500)); // the first batch is in flight
    await server.stop();

    fake.bulkDelayMs = 0;
    server = await startServer({ env: { ...fake.env, ...ENV, NUXT_SUBMISSION_BATCH_SIZE: '1' }, dataDir: server.dataDir });
    browser = await login(server, false);
    const view = await (await api(`/submissions/${id}`)).json();
    expect(view.status).toBe('interrupted');
    expect(view.items.find((i: { playerId: string }) => i.playerId === '2').outcome).toBe('skipped');

    const res = await api(`/submissions/${id}/retry`, { method: 'POST', json: {} });
    expect(await finished((await res.json()).submissionId)).toMatchObject({ status: 'succeeded' });
    expect(upstreamIds()).toEqual(['1', '2', '9999991']);
  });
});

function parseSse(text: string): { id: string; event: string; data: string }[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const field = (name: string) =>
        block
          .split('\n')
          .find((l) => l.startsWith(`${name}:`))
          ?.slice(name.length + 1)
          .trim() ?? '';
      return { id: field('id'), event: field('event'), data: field('data') };
    })
    .filter((e) => e.event);
}
