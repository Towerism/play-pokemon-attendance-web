/**
 * Spike S8 part 2 (#85): the write steps of `spikes/s8-live.ts`, with the
 * transport, clock and ledger injected so the guarantees that protect real
 * tournaments are tested in-process:
 *
 * - a create POST is never resent (an ambiguous failure is looked up instead);
 * - writes are ≥ 10 s apart, measured from the end of the previous write;
 * - an edit always ends with a restore check;
 * - nothing is written to a tournament the step isn't meant for.
 */
import {
  type CreateBody,
  type DateFormat,
  type Plan,
  type PlanEvent,
  type PlanProblem,
  type PlanTemplate,
  type TournamentDetail,
  cancelRefusal,
  confirmCode,
  createBody,
  restoreActions,
  tdfMismatch,
  validatePlan,
} from './s8';
import { readTdfHeader } from './tdf-summary';

export interface UpstreamResponse {
  status: number;
  body: unknown;
}

export interface Upstream {
  call(method: string, path: string, opts?: { query?: Record<string, string | number>; body?: unknown }): Promise<UpstreamResponse>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface S8Ledger {
  created: { guid: string; display_id: string; planned: PlanEvent; template: PlanTemplate; response: unknown }[];
  uploads: { display_id: string; upload_guid: string; errors: string[]; confirmedWith?: 'guid' | 'display_id' }[];
}

export interface Deps {
  up: Upstream;
  clock: Clock;
  ledger: { load(): S8Ledger; save(l: S8Ledger): void };
  log(line: string): void;
}

export const WRITE_SPACING_MS = 10_000;
const POLL_MS = 30_000;
const WATCH_MAX_MS = 90 * 60_000;
const MAX_RESTORE_PATCHES = 3;
const HOUR_MS = 3_600_000;

const ok = (status: number) => status >= 200 && status < 300;
const isClientError = (status: number) => status >= 400 && status < 500;
const mask = (id: string) => `…${id.slice(-2)}`;

type Refused = { outcome: 'refused'; reason: string; status?: number; problems?: PlanProblem[] };
const refused = (deps: Deps, reason: string, extra: Partial<Refused> = {}): Refused => {
  deps.log(`  ✗ ${reason}. Nothing was written.`);
  return { outcome: 'refused', reason, ...extra };
};

function writer(deps: Deps) {
  let lastEnd = -Infinity;
  return async (method: string, path: string, body: unknown): Promise<UpstreamResponse> => {
    const wait = lastEnd + WRITE_SPACING_MS - deps.clock.now();
    if (wait > 0) await deps.clock.sleep(wait);
    try {
      return await deps.up.call(method, path, { body });
    } finally {
      lastEnd = deps.clock.now();
    }
  };
}

const tournamentPath = (guid: string) => `core/tournament/${guid}`;
const patchPath = (guid: string) => `core/tournament/${guid}/`;

async function readTournament(deps: Deps, guid: string): Promise<TournamentDetail | null> {
  const res = await deps.up.call('GET', tournamentPath(guid));
  return ok(res.status) ? (res.body as TournamentDetail) : null;
}

type ActivityRow = Record<string, unknown> & { guid?: string; display_id?: string; name?: string; start_date_v2?: string };

/** Pages the organizer's tournaments (newest first; date filters are ignored upstream, S6) until `stop` says so. */
async function findActivity(deps: Deps, match: (r: ActivityRow) => boolean, stop: (r: ActivityRow) => boolean): Promise<ActivityRow | null> {
  for (let page = 1; page <= 20; page++) {
    const res = await deps.up.call('GET', 'core/activities', { query: { type: 'tournament', role: 'organizer', sort_by: '-start_date', page } });
    if (!ok(res.status)) return null;
    const body = res.body as { results?: ActivityRow[]; next?: unknown };
    const rows = body.results ?? [];
    const hit = rows.find(match);
    if (hit) return hit;
    if (!body.next || rows.some(stop)) return null;
  }
  return null;
}

const startKey = (body: CreateBody) => body.start_date_v2 ?? body.start_date ?? '';

async function findLanded(deps: Deps, e: PlanEvent, body: CreateBody): Promise<ActivityRow | null> {
  const start = Date.parse(startKey(body));
  return findActivity(
    deps,
    (r) => r.name === e.name && Date.parse(String(r.start_date_v2 ?? r.start_date)) === start,
    (r) => Date.parse(String(r.start_date_v2)) < start,
  );
}

export type CreateResult =
  | { outcome: 'dry-run'; code: string; bodies: CreateBody[] }
  | { outcome: 'created'; guid: string }
  | { outcome: 'ambiguous'; landed: { guid: string } | null }
  | Refused;

export async function runCreate(deps: Deps, opts: { plan: Plan; planBytes: Uint8Array; fmt: DateFormat; confirm?: string }): Promise<CreateResult> {
  const problems = validatePlan(opts.plan, { now: new Date(deps.clock.now()) });
  if (problems.length) return refused(deps, `The plan has ${problems.length} problem(s)`, { problems });
  const [e] = opts.plan.events as [PlanEvent];
  const body = createBody(e, opts.plan.template, opts.fmt);
  const code = confirmCode(opts.planBytes);
  if (opts.confirm === undefined) return { outcome: 'dry-run', code, bodies: [body] };
  if (opts.confirm !== code) return refused(deps, '--confirm does not match this plan file');

  const ledger = deps.ledger.load();
  if (ledger.created.some((c) => c.planned.name === e.name && c.planned.local_start === e.local_start)) {
    return refused(deps, 'This event is already in the ledger; a second create would duplicate it');
  }
  const remember = (guid: string, display_id: string, response: unknown) => {
    const l = deps.ledger.load();
    l.created.push({ guid, display_id, planned: e, template: opts.plan.template, response });
    deps.ledger.save(l);
  };

  let res: UpstreamResponse | null = null;
  try {
    res = await writer(deps)('POST', 'core/tournament', body);
  } catch (err) {
    deps.log(`  POST core/tournament failed: ${(err as Error).message}. Not resending; looking it up instead.`);
  }
  if (res && isClientError(res.status)) {
    deps.log(`  POST core/tournament → ${res.status}: ${JSON.stringify(res.body)}`);
    return refused(deps, `Create was refused (${res.status})`, { status: res.status });
  }
  if (!res || !ok(res.status)) {
    const row = await findLanded(deps, e, body);
    if (row?.guid) remember(row.guid, String(row.display_id ?? ''), res?.body ?? null);
    deps.log(row ? `  The tournament DID land (${row.display_id}). It is in the ledger.` : '  It did not land (not in core/activities). Rerun only if you want it.');
    return { outcome: 'ambiguous', landed: row?.guid ? { guid: row.guid } : null };
  }

  let guid = (res.body as { guid?: unknown } | null)?.guid;
  let displayId = '';
  if (typeof guid !== 'string') {
    const row = await findLanded(deps, e, body);
    if (!row?.guid) return refused(deps, 'Create answered 2xx without a guid, and the tournament was not found');
    guid = row.guid;
    displayId = String(row.display_id ?? '');
  }
  remember(guid as string, displayId, res.body);
  const t = await readTournament(deps, guid as string);
  if (t) {
    const l = deps.ledger.load();
    const entry = l.created.find((c) => c.guid === guid);
    if (entry) entry.display_id = t.display_id;
    deps.ledger.save(l);
    const r = t as unknown as Record<string, unknown>;
    deps.log(`  created ${t.display_id}: ${['status', 'application_state', 'activity_state', 'start_date', 'start_date_v2', 'start_date_actual'].map((k) => `${k}=${JSON.stringify(r[k] ?? null)}`).join(' ')}`);
  } else {
    deps.log(`  created ${mask(guid as string)}, but reading it back failed. It is in the ledger.`);
  }
  return { outcome: 'created', guid: guid as string };
}

export interface EditResult {
  outcome: 'done' | 'refused';
  restored?: boolean;
  reason?: string;
}

export async function runEdit(deps: Deps, opts: { guid: string; confirm?: string }): Promise<EditResult> {
  const entry = deps.ledger.load().created.find((c) => c.guid === opts.guid);
  if (!entry) return refused(deps, 'This tournament is not in the ledger; edit only touches what this run created');
  if (opts.confirm !== opts.guid.slice(-6)) return refused(deps, '--confirm does not match the tournament');
  const snapshot = await readTournament(deps, opts.guid);
  if (!snapshot) return refused(deps, 'Could not read the tournament');

  const write = writer(deps);
  const full = (change: Partial<CreateBody>): CreateBody => ({
    ...createBody(entry.planned, entry.template, 'v2'),
    details: snapshot.details ?? '',
    start_date_v2: snapshot.start_date_v2,
    ...change,
  });
  /** A partial PATCH; a 4xx is retried once as the full body (that is the evidence). */
  const patch = async (change: Partial<CreateBody>): Promise<UpstreamResponse> => {
    const res = await write('PATCH', patchPath(opts.guid), change);
    deps.log(`  PATCH ${Object.keys(change).join(', ')} → ${res.status}`);
    if (!isClientError(res.status)) return res;
    const again = await write('PATCH', patchPath(opts.guid), full(change));
    deps.log(`  PATCH (full body) ${Object.keys(change).join(', ')} → ${again.status}`);
    return again;
  };

  const startMs = Date.parse(snapshot.start_date_v2 ?? '');
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const steps: Partial<CreateBody>[] = [
    { details: `${snapshot.details ?? ''} .` },
    { details: snapshot.details ?? '' },
    { start_date_v2: iso(startMs + HOUR_MS) },
    { start_date_v2: iso(startMs) },
  ];
  try {
    for (const step of steps) {
      const res = await patch(step);
      const after = await readTournament(deps, opts.guid);
      const r = (after ?? {}) as Record<string, unknown>;
      deps.log(`    now application_state=${String(r.application_state ?? r.status)} activity_state=${String(r.activity_state)} start_date_v2=${String(r.start_date_v2)}`);
      if (!ok(res.status)) break;
    }
  } catch (err) {
    deps.log(`  edit stopped: ${(err as Error).message}`);
  }
  return { outcome: 'done', restored: await restoreCheck(deps, opts.guid, snapshot, patch) };
}

async function restoreCheck(deps: Deps, guid: string, snapshot: TournamentDetail, patch: (c: Partial<CreateBody>) => Promise<UpstreamResponse>): Promise<boolean> {
  let pending: Partial<CreateBody> | null = null;
  for (let attempt = 0; attempt <= MAX_RESTORE_PATCHES; attempt++) {
    const current = await readTournament(deps, guid).catch(() => null);
    pending = current ? restoreActions(snapshot, current) : { details: snapshot.details ?? '', start_date_v2: snapshot.start_date_v2 };
    if (!pending) {
      deps.log('  ✓ RESTORED: details and start match the snapshot');
      return true;
    }
    if (attempt === MAX_RESTORE_PATCHES) break;
    await patch(pending).catch((err: Error) => deps.log(`  restore PATCH failed: ${err.message}`));
  }
  deps.log(`  ✗✗ NOT RESTORED. Set by hand in play-tools: ${JSON.stringify(pending)}`);
  return false;
}

async function resolve(deps: Deps, displayId: string): Promise<string | null> {
  const fromLedger = deps.ledger.load().created.find((c) => c.display_id === displayId)?.guid;
  if (fromLedger) return fromLedger;
  const row = await findActivity(deps, (r) => r.display_id === displayId, () => false);
  return row?.guid ?? null;
}

export async function runCancel(deps: Deps, opts: { displayId: string; confirm?: string }): Promise<{ outcome: 'done' | 'refused'; reason?: string }> {
  const guid = await resolve(deps, opts.displayId);
  if (!guid) return refused(deps, `No tournament ${opts.displayId} among yours`);
  const t = await readTournament(deps, guid);
  if (!t) return refused(deps, 'Could not read the tournament');
  const why = cancelRefusal(t, deps.ledger.load(), new Date(deps.clock.now()));
  if (why) return refused(deps, why);
  if (opts.confirm !== guid.slice(-6)) return refused(deps, '--confirm does not match the tournament');

  const res = await writer(deps)('PATCH', patchPath(guid), { application_state: 'cancelled' });
  deps.log(`  cancel → ${res.status}`);
  const after = await readTournament(deps, guid);
  deps.log(`    now application_state=${String(after?.application_state ?? after?.status)}`);
  const row = await findActivity(deps, (r) => r.guid === guid, () => false);
  deps.log(`    core/activities status=${String(row?.status)}`);
  return { outcome: 'done' };
}

async function ownTournament(deps: Deps, displayId: string): Promise<{ guid: string; t: TournamentDetail } | Refused> {
  const entry = deps.ledger.load().created.find((c) => c.display_id === displayId);
  if (!entry) return refused(deps, 'TDF steps only touch the tournament this run created');
  const t = await readTournament(deps, entry.guid);
  if (!t) return refused(deps, 'Could not read the tournament');
  return { guid: entry.guid, t };
}

export async function runTdfValidate(
  deps: Deps,
  opts: { displayId: string; file: Buffer; confirm?: string; expectedGametype: string },
): Promise<{ outcome: 'done' | 'refused'; reason?: string; errors?: string[] }> {
  const own = await ownTournament(deps, opts.displayId);
  if ('outcome' in own) return own;
  const records = await deps.up.call('GET', `core/tournaments/${own.guid}/records`, { query: { player: 'true', page_size: 1 } });
  const players = ok(records.status) ? Number((records.body as { count?: unknown }).count ?? 0) : Number.NaN;
  if (Number.isNaN(players)) return refused(deps, 'Could not count the tournament’s player records');
  const header = readTdfHeader(opts.file.toString('utf8'));
  const why = tdfMismatch(header, own.t, players, opts.expectedGametype);
  if (why) return refused(deps, why);
  if (opts.confirm !== own.guid.slice(-6)) return refused(deps, '--confirm does not match the tournament');

  const res = await writer(deps)('POST', 'triumph/tdf/', { kind: 'tdf', tournament_id: opts.displayId, payload: opts.file.toString('base64') });
  const body = (res.body ?? {}) as { upload_guid?: unknown; errors?: unknown };
  const errors = Array.isArray(body.errors) ? body.errors.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : [];
  deps.log(`  validate → ${res.status}; errors: ${errors.length ? errors.join(', ') : 'none'}`);
  if (typeof body.upload_guid === 'string') {
    const l = deps.ledger.load();
    l.uploads.push({ display_id: opts.displayId, upload_guid: body.upload_guid, errors });
    deps.ledger.save(l);
  }
  return { outcome: 'done', errors };
}

export async function runTdfConfirm(deps: Deps, opts: { displayId: string; confirm?: string }): Promise<{ outcome: 'done' | 'refused'; reason?: string }> {
  const upload = deps.ledger.load().uploads.findLast((u) => u.display_id === opts.displayId);
  if (!upload) return refused(deps, 'No validated upload for this tournament; run tdf-validate first');
  if (upload.errors.length) return refused(deps, `Validate returned errors (${upload.errors.join(', ')}); not confirming`);
  const own = await ownTournament(deps, opts.displayId);
  if ('outcome' in own) return own;
  if (opts.confirm !== own.guid.slice(-6)) return refused(deps, '--confirm does not match the tournament');

  const write = writer(deps);
  const path = `triumph/${upload.upload_guid}/confirm/`;
  let confirmedWith: 'guid' | 'display_id' | undefined;
  const byGuid = await write('PUT', path, { tournament_id: own.guid });
  deps.log(`  confirm with the tournament guid → ${byGuid.status}`);
  if (ok(byGuid.status)) confirmedWith = 'guid';
  else if (isClientError(byGuid.status)) {
    const byDisplay = await write('PUT', path, { tournament_id: opts.displayId });
    deps.log(`  confirm with the display id → ${byDisplay.status}`);
    if (ok(byDisplay.status)) confirmedWith = 'display_id';
  }
  const l = deps.ledger.load();
  const saved = l.uploads.findLast((u) => u.upload_guid === upload.upload_guid);
  if (saved && confirmedWith) saved.confirmedWith = confirmedWith;
  deps.ledger.save(l);
  return confirmedWith ? { outcome: 'done' } : refused(deps, 'Neither confirm form was accepted');
}

const WAITING = ['pending', 'upload_in_progress'];

export async function runTdfWatch(
  deps: Deps,
  opts: { displayId: string },
): Promise<{ outcome: 'done' | 'timeout' | 'refused'; finalState?: string; secondsIn?: Record<string, number>; reason?: string }> {
  const own = deps.ledger.load().created.find((c) => c.display_id === opts.displayId);
  if (!own) return refused(deps, 'TDF steps only touch the tournament this run created');
  const started = deps.clock.now();
  const secondsIn: Record<string, number> = {};
  let state = '';
  let seenAt = started;
  for (;;) {
    const t = await readTournament(deps, own.guid);
    const now = deps.clock.now();
    if (state) secondsIn[state] = (secondsIn[state] ?? 0) + (now - seenAt) / 1000;
    state = String(t?.activity_state ?? 'unreadable');
    seenAt = now;
    deps.log(`  +${Math.round((now - started) / 1000)} s activity_state=${state}`);
    if (!WAITING.includes(state)) break;
    if (now - started >= WATCH_MAX_MS) {
      deps.log(`  Still ${state} after 90 min; stopping the watch.`);
      return { outcome: 'timeout', finalState: state, secondsIn };
    }
    await deps.clock.sleep(POLL_MS);
  }
  await deps.up.call('GET', `triumph/tournament/${opts.displayId}/uploads/`);
  const upload = deps.ledger.load().uploads.findLast((u) => u.display_id === opts.displayId);
  if (upload) await deps.up.call('GET', `triumph/tdf/${upload.upload_guid}`);
  return { outcome: 'done', finalState: state, secondsIn };
}
