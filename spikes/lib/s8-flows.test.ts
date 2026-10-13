import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, FakePlayTools } from './fake-play-tools';
import { type Plan, type PlanEvent, confirmCode, createBody } from './s8';
import { type Deps, type S8Ledger, runCancel, runCreate, runEdit, runTdfConfirm, runTdfValidate, runTdfWatch } from './s8-flows';

const TEMPLATE: Plan['template'] = {
  activity_group_id: 'ag-guid',
  organizer_id: 'organizer-guid',
  address_id: 'address-guid',
  timezone: 'America/Chicago',
  contact_information: { email: 'league@example.com' },
};
const EVENT: PlanEvent = { name: "Ettin's TCG Practice Tournament", product: 'tcg', category: 'tcg_std', series_guid: null, local_start: '2026-10-12T10:00' };
const PLAN: Plan = { template: TEMPLATE, categories: { tcg: ['tcg_std'] }, series: [], events: [EVENT] };
const PLAN_BYTES = new TextEncoder().encode(JSON.stringify(PLAN));
const CODE = confirmCode(PLAN_BYTES);

function tdfFile(over: { id?: string; organizer?: string; gametype?: string } = {}): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<tournament gametype="${over.gametype ?? 'TRADING_CARD_GAME'}"><data><id>${over.id ?? '26-10-000001'}</id><organizer popid="${over.organizer ?? '7654321'}" /></data><players></players></tournament>
`);
}

let clock: FakeClock;
let up: FakePlayTools;
let ledger: S8Ledger;
let logs: string[];
let deps: Deps;

beforeEach(() => {
  clock = new FakeClock();
  up = new FakePlayTools(clock);
  ledger = { created: [], uploads: [] };
  logs = [];
  deps = {
    up,
    clock,
    ledger: { load: () => structuredClone(ledger), save: (l) => (ledger = structuredClone(l)) },
    log: (line) => logs.push(line),
  };
});

/** A tournament this run created, as `create` would have left it. */
function created() {
  const t = up.add({ name: EVENT.name, start_date_v2: '2026-10-12T15:00:00Z', details: 'Bring a deck' });
  ledger.created.push({ guid: t.guid, display_id: t.display_id, planned: EVENT, template: TEMPLATE, response: { guid: t.guid } });
  return t;
}

describe('runCreate', () => {
  it('posts the one event, reads it back and adds it to the ledger', async () => {
    const r = await runCreate(deps, { plan: PLAN, planBytes: PLAN_BYTES, fmt: 'v2', confirm: CODE });

    expect(r.outcome).toBe('created');
    expect(up.count('POST', /^core\/tournament$/)).toBe(1);
    expect(up.sent.find((c) => c.method === 'POST')?.body).toEqual(createBody(EVENT, TEMPLATE, 'v2'));
    expect(up.count('GET', /^core\/tournament\/t-guid-1$/)).toBe(1);
    expect(ledger.created).toEqual([expect.objectContaining({ guid: 't-guid-1', display_id: '26-10-000001', planned: EVENT })]);
  });

  it('is a dry run without a code, and sends nothing with a wrong one', async () => {
    const dry = await runCreate(deps, { plan: PLAN, planBytes: PLAN_BYTES, fmt: 'v2' });
    expect(dry).toMatchObject({ outcome: 'dry-run', code: CODE, bodies: [createBody(EVENT, TEMPLATE, 'v2')] });

    const wrong = await runCreate(deps, { plan: PLAN, planBytes: PLAN_BYTES, fmt: 'v2', confirm: '000000' });
    expect(wrong.outcome).toBe('refused');
    expect(up.sent).toEqual([]);
  });

  it('refuses an invalid plan before any request', async () => {
    const bad = { ...PLAN, events: [{ ...EVENT, name: '' }] };
    const bytes = new TextEncoder().encode(JSON.stringify(bad));
    const r = await runCreate(deps, { plan: bad, planBytes: bytes, fmt: 'v2', confirm: confirmCode(bytes) });
    expect(r).toMatchObject({ outcome: 'refused', problems: [expect.objectContaining({ field: 'name' })] });
    expect(up.sent).toEqual([]);
  });

  it('never resends a POST that timed out, and reports that it landed when it did', async () => {
    up.failOnce((c) => c.method === 'POST', 'throw');
    // The timed-out POST did land upstream.
    up.add({ name: EVENT.name, start_date_v2: '2026-10-12T15:00:00Z' });
    up.add({ name: 'Older', start_date_v2: '2026-09-01T15:00:00Z' });
    up.add({ name: 'Oldest', start_date_v2: '2026-08-01T15:00:00Z' });

    const r = await runCreate(deps, { plan: PLAN, planBytes: PLAN_BYTES, fmt: 'v2', confirm: CODE });

    expect(r).toMatchObject({ outcome: 'ambiguous', landed: { guid: 't-guid-1' } });
    expect(up.count('POST', /^core\/tournament$/)).toBe(1);
    expect(up.count('GET', /^core\/activities$/)).toBeGreaterThanOrEqual(1);
    expect(ledger.created.map((c) => c.guid)).toEqual(['t-guid-1']);
  });

  it('never resends a POST that got a 5xx, and reports that it did not land', async () => {
    up.failOnce((c) => c.method === 'POST', { status: 502, body: null });
    up.add({ name: 'Older', start_date_v2: '2026-09-01T15:00:00Z' });

    const r = await runCreate(deps, { plan: PLAN, planBytes: PLAN_BYTES, fmt: 'v2', confirm: CODE });

    expect(r).toMatchObject({ outcome: 'ambiguous', landed: null });
    expect(up.count('POST', /^core\/tournament$/)).toBe(1);
    expect(ledger.created).toEqual([]);
  });

  it('pages core/activities until starts fall below the event, to find one that landed on a later page', async () => {
    up.failOnce((c) => c.method === 'POST', 'throw');
    up.add({ name: 'Upcoming 1', start_date_v2: '2026-10-25T15:00:00Z' });
    up.add({ name: 'Upcoming 2', start_date_v2: '2026-10-18T15:00:00Z' });
    up.add({ name: EVENT.name, start_date_v2: '2026-10-12T15:00:00Z' });
    up.add({ name: 'Older', start_date_v2: '2026-09-01T15:00:00Z' });

    const r = await runCreate(deps, { plan: PLAN, planBytes: PLAN_BYTES, fmt: 'v2', confirm: CODE });

    expect(r).toMatchObject({ outcome: 'ambiguous', landed: { guid: 't-guid-3' } });
    expect(up.count('GET', /^core\/activities$/)).toBe(2);
  });

  it('refuses a rerun of an event already in the ledger', async () => {
    created();
    const r = await runCreate(deps, { plan: PLAN, planBytes: PLAN_BYTES, fmt: 'v2', confirm: CODE });
    expect(r.outcome).toBe('refused');
    expect(up.count('POST', /.*/)).toBe(0);
  });

  it('keeps a created tournament in the ledger even when its read-back fails', async () => {
    up.failOnce((c) => c.method === 'GET' && c.path.startsWith('core/tournament/'), { status: 500, body: null });
    const r = await runCreate(deps, { plan: PLAN, planBytes: PLAN_BYTES, fmt: 'v2', confirm: CODE });
    expect(r.outcome).toBe('created');
    expect(ledger.created.map((c) => c.guid)).toEqual(['t-guid-1']);
  });

  it('finds the tournament by name and start when a 2xx has no guid', async () => {
    up.failOnce((c) => c.method === 'POST', { status: 201, body: {} });
    up.add({ name: EVENT.name, start_date_v2: '2026-10-12T15:00:00Z' });
    const r = await runCreate(deps, { plan: PLAN, planBytes: PLAN_BYTES, fmt: 'v2', confirm: CODE });
    expect(r).toMatchObject({ outcome: 'created', guid: 't-guid-1' });
  });

  it('stops on a 4xx refusal and records it, without trying the other date format', async () => {
    up.failOnce((c) => c.method === 'POST', { status: 400, body: { errors: { body: { start_date_v2: [{ code: 'invalid' }] } } } });
    const r = await runCreate(deps, { plan: PLAN, planBytes: PLAN_BYTES, fmt: 'v2', confirm: CODE });
    expect(r).toMatchObject({ outcome: 'refused', status: 400 });
    expect(up.count('POST', /.*/)).toBe(1);
  });
});

describe('runEdit', () => {
  it('changes details and the start one at a time, re-reads after each, and ends restored', async () => {
    const t = created();
    const r = await runEdit(deps, { guid: t.guid, confirm: t.guid.slice(-6) });

    const patches = up.sent.filter((c) => c.method === 'PATCH').map((c) => c.body);
    expect(patches).toEqual([
      { details: 'Bring a deck .' },
      { details: 'Bring a deck' },
      { start_date_v2: '2026-10-12T16:00:00Z' },
      { start_date_v2: '2026-10-12T15:00:00Z' },
    ]);
    expect(r.restored).toBe(true);
    expect(up.tournaments.get(t.guid)).toMatchObject({ details: 'Bring a deck', start_date_v2: '2026-10-12T15:00:00Z' });
  });

  it('spaces writes at least 10 s apart, measured from the end of the previous one', async () => {
    const t = created();
    await runEdit(deps, { guid: t.guid, confirm: t.guid.slice(-6) });
    const at = up.sent.filter((c) => c.method === 'PATCH').map((c) => c.at);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(10_000);
  });

  it('refuses a tournament the run did not create, sending no write', async () => {
    const t = up.add();
    const r = await runEdit(deps, { guid: t.guid, confirm: t.guid.slice(-6) });
    expect(r.outcome).toBe('refused');
    expect(up.count('PATCH', /.*/)).toBe(0);
  });

  it('refuses a wrong confirmation code, sending no write', async () => {
    const t = created();
    const r = await runEdit(deps, { guid: t.guid, confirm: 'nope' });
    expect(r.outcome).toBe('refused');
    expect(up.count('PATCH', /.*/)).toBe(0);
  });

  it('restores the start after the date restore fails with a 500', async () => {
    const t = created();
    up.failOnce((c) => c.method === 'PATCH' && (c.body as { start_date_v2?: string }).start_date_v2 === '2026-10-12T15:00:00Z', { status: 500, body: null });

    const r = await runEdit(deps, { guid: t.guid, confirm: t.guid.slice(-6) });

    expect(r.restored).toBe(true);
    expect(up.tournaments.get(t.guid)?.start_date_v2).toBe('2026-10-12T15:00:00Z');
  });

  it('says NOT RESTORED with the values to set by hand after 3 corrective PATCHes fail', async () => {
    const t = created();
    const restore = (c: { method: string; body: unknown }) => c.method === 'PATCH' && (c.body as { start_date_v2?: string }).start_date_v2 === '2026-10-12T15:00:00Z';
    for (let i = 0; i < 4; i++) up.failOnce(restore, { status: 500, body: null });

    const r = await runEdit(deps, { guid: t.guid, confirm: t.guid.slice(-6) });

    expect(r.restored).toBe(false);
    expect(logs.join('\n')).toMatch(/NOT RESTORED[\s\S]*start_date_v2.*2026-10-12T15:00:00Z/);
    expect(up.count('PATCH', /.*/)).toBe(4 + 3);
  });

  it('retries a refused partial PATCH once as the full create body with only that field changed', async () => {
    const t = created();
    up.refusePartialPatch = true;

    await runEdit(deps, { guid: t.guid, confirm: t.guid.slice(-6) });

    const [partial, full] = up.sent.filter((c) => c.method === 'PATCH');
    expect(partial?.body).toEqual({ details: 'Bring a deck .' });
    expect(full?.body).toEqual({ ...createBody(EVENT, TEMPLATE, 'v2'), details: 'Bring a deck .', start_date_v2: '2026-10-12T15:00:00Z' });
    expect(up.tournaments.get(t.guid)).toMatchObject({ details: 'Bring a deck', start_date_v2: '2026-10-12T15:00:00Z' });
  });
});

describe('runCancel', () => {
  it('cancels a sanctioned tournament found by display id, then re-reads it and its activities row', async () => {
    const t = up.add({ start_date_v2: '2026-09-01T23:30:00Z' });
    const r = await runCancel(deps, { displayId: t.display_id, confirm: t.guid.slice(-6) });

    expect(r.outcome).toBe('done');
    expect(up.sent.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ application_state: 'cancelled' }]);
    expect(up.tournaments.get(t.guid)?.application_state).toBe('cancelled');
  });

  it('refuses the run’s own tournament, sending no write', async () => {
    const t = created();
    const r = await runCancel(deps, { displayId: t.display_id, confirm: t.guid.slice(-6) });
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/ledger/) });
    expect(up.count('PATCH', /.*/)).toBe(0);
  });

  it('refuses a wrong code, sending no write', async () => {
    const t = up.add({ start_date_v2: '2026-09-01T23:30:00Z' });
    expect((await runCancel(deps, { displayId: t.display_id, confirm: 'nope' })).outcome).toBe('refused');
    expect(up.count('PATCH', /.*/)).toBe(0);
  });
});

describe('runTdfValidate', () => {
  it('sends one validate with the display id and the file as base64 when everything matches', async () => {
    const t = created();
    const file = tdfFile();
    const r = await runTdfValidate(deps, { displayId: t.display_id, file, confirm: t.guid.slice(-6), expectedGametype: 'TRADING_CARD_GAME' });

    expect(r.outcome).toBe('done');
    expect(up.sent.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { kind: 'tdf', tournament_id: t.display_id, payload: file.toString('base64') },
    ]);
    expect(ledger.uploads).toEqual([{ display_id: t.display_id, upload_guid: 'upload-1', errors: [] }]);
  });

  it.each([
    ['another tournament id', () => tdfFile({ id: '26-10-999999' }), /tournament id/],
    ['another organizer', () => tdfFile({ organizer: '1111111' }), /organizer/],
    ['another gametype', () => tdfFile({ gametype: 'VIDEO_GAME' }), /gametype/],
  ])('sends nothing for a file with %s', async (_label, file, reason) => {
    const t = created();
    const r = await runTdfValidate(deps, { displayId: t.display_id, file: file(), confirm: t.guid.slice(-6), expectedGametype: 'TRADING_CARD_GAME' });
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(reason) });
    expect(up.count('POST', /.*/)).toBe(0);
  });

  it('sends nothing when the tournament already has a player record', async () => {
    const t = created();
    up.playerRecords.set(t.guid, 1);
    const r = await runTdfValidate(deps, { displayId: t.display_id, file: tdfFile(), confirm: t.guid.slice(-6), expectedGametype: 'TRADING_CARD_GAME' });
    expect(r).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/player record/) });
    expect(up.count('POST', /.*/)).toBe(0);
  });

  it('only uploads to the run’s own tournament', async () => {
    const t = up.add();
    const r = await runTdfValidate(deps, { displayId: t.display_id, file: tdfFile({ id: t.display_id }), confirm: t.guid.slice(-6), expectedGametype: 'TRADING_CARD_GAME' });
    expect(r.outcome).toBe('refused');
    expect(up.count('POST', /.*/)).toBe(0);
  });
});

describe('runTdfConfirm', () => {
  async function validated() {
    const t = created();
    await runTdfValidate(deps, { displayId: t.display_id, file: tdfFile(), confirm: t.guid.slice(-6), expectedGametype: 'TRADING_CARD_GAME' });
    return t;
  }

  it('confirms with the tournament guid when that is accepted', async () => {
    const t = await validated();
    const r = await runTdfConfirm(deps, { displayId: t.display_id, confirm: t.guid.slice(-6) });
    expect(r.outcome).toBe('done');
    expect(up.sent.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ tournament_id: t.guid }]);
    expect(ledger.uploads[0]?.confirmedWith).toBe('guid');
  });

  it('tries the display id once after the guid is refused, and records that form', async () => {
    const t = await validated();
    up.confirmAccepts = 'display_id';
    await runTdfConfirm(deps, { displayId: t.display_id, confirm: t.guid.slice(-6) });
    expect(up.sent.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ tournament_id: t.guid }, { tournament_id: t.display_id }]);
    expect(ledger.uploads[0]?.confirmedWith).toBe('display_id');
  });

  it('never confirms an upload whose validate returned errors', async () => {
    const t = created();
    ledger.uploads.push({ display_id: t.display_id, upload_guid: 'upload-9', errors: ['PLAYER_IDS_CHECK_ERROR'] });
    const r = await runTdfConfirm(deps, { displayId: t.display_id, confirm: t.guid.slice(-6) });
    expect(r.outcome).toBe('refused');
    expect(up.count('PUT', /.*/)).toBe(0);
  });
});

describe('runTdfWatch', () => {
  it('polls every 30 s until the upload leaves upload_in_progress, and measures the time in it', async () => {
    const t = created();
    ledger.uploads.push({ display_id: t.display_id, upload_guid: 'upload-1', errors: [], confirmedWith: 'guid' });
    up.uploads.set('upload-1', { display_id: t.display_id, confirmed: true });
    up.afterConfirm = ['upload_in_progress', 'upload_in_progress', 'upload_in_progress', 'upload_in_progress', 'completed'];

    const r = await runTdfWatch(deps, { displayId: t.display_id });

    expect(up.count('GET', new RegExp(`^core/tournament/${t.guid}$`))).toBe(5);
    expect(r).toMatchObject({ outcome: 'done', finalState: 'completed', secondsIn: { upload_in_progress: 120 } });
    expect(up.count('GET', /^triumph\/tournament\/.+\/uploads\/$/)).toBe(1);
    expect(up.count('GET', /^triumph\/tdf\/upload-1$/)).toBe(1);
  });

  it('gives up after 90 minutes still in progress, and says so', async () => {
    const t = created();
    ledger.uploads.push({ display_id: t.display_id, upload_guid: 'upload-1', errors: [], confirmedWith: 'guid' });
    up.uploads.set('upload-1', { display_id: t.display_id, confirmed: true });
    up.afterConfirm = ['upload_in_progress'];

    const r = await runTdfWatch(deps, { displayId: t.display_id });

    expect(r).toMatchObject({ outcome: 'timeout', finalState: 'upload_in_progress' });
    expect(clock.now() - Date.parse('2026-10-13T15:40:00Z')).toBe(90 * 60_000);
    expect(logs.join('\n')).toMatch(/90 min/);
  });
});
