/**
 * Spike S6, live: the tournament staff contract, recorded through the API.
 * The organizer agreed to this on 2026-10-11: on their most recent tournament
 * with 2+ staff, remove one non-organizer staffer, probe with them, and put
 * them back with their original role.
 *
 *   pnpm spike:s6-live discover                     read-only; saves .secrets/s6-plan.json
 *   pnpm spike:s6-live probe --confirm <code>       WRITES; code = last 6 chars of the tournament guid
 *   pnpm spike:s6 spikes/.secrets/raw/s6-live.json  sanitise the recording into fixtures
 *
 * Probe steps (writes ≥ 10 s apart):
 *   reads    tournament details, staff, players (2 pages), unfiltered records, date-filtered activities
 *   1. DELETE the staffer (body [{legacy_alias}])           → remove contract
 *   2. POST them back with their original role              → assign contract (restores at once)
 *   3. POST them again                                      → duplicate error body
 *   4. PATCH their role to another one, 5. PATCH it back    → change-role contract
 *   6. POST player id "0" (cannot be a real player)         → invalid-id error body
 *   finally  re-read staff; re-add/re-role the staffer and delete anything the probe added,
 *            until the staff list matches the snapshot. Print loudly if it doesn't.
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { OP_API_BASE } from '../server/modules/pokemon/adapters/play-tools/constants';
import { fail, heading, run, sleep } from './lib/cli';
import type { ApiCall } from './lib/har';
import { op } from './lib/op';
import { RAW_DIR, SECRETS_DIR, readSecretJson, writeSecretJson } from './lib/secrets';
import { otherRole, pickStaffer, repairActions, toStaff, withinAddWindow, type Staff } from './lib/staff';

const WRITE_SPACING_MS = 10_000;
const INVALID_PLAYER_ID = '0';
const PLAN_FILE = join(SECRETS_DIR, 's6-plan.json');
const RECORDING = join(RAW_DIR, 's6-live.json');

interface Plan {
  tournament: { guid: string; displayId: string; start: string };
  staffBefore: Staff[];
  target: Staff;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Query = Record<string, string | number | boolean>;
const recorded: ApiCall[] = [];

async function call(method: Method, path: string, opts: { query?: Query; body?: unknown } = {}) {
  const query = Object.fromEntries(Object.entries(opts.query ?? {}).map(([k, v]) => [k, String(v)]));
  const res = await op(method, path, { query, body: opts.body });
  const url = new URL(path, OP_API_BASE);
  recorded.push({
    method,
    path: url.pathname,
    query: { ...Object.fromEntries(url.searchParams), ...query },
    status: res.status,
    request: opts.body ?? null,
    response: res.body,
  });
  return res;
}

let lastWriteAt = 0;
async function write(method: Method, path: string, body: unknown) {
  const wait = lastWriteAt + WRITE_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  const res = await call(method, path, { body });
  lastWriteAt = Date.now();
  return res;
}

const recordsPath = (t: string) => `core/tournaments/${t}/records`;
const recordPath = (t: string, r: string) => `core/tournaments/${t}/records/${r}`;
const mask = (id: string) => `…${id.slice(-2)}`;
const show = (s: Staff) => `${s.role ?? '(no role)'} ${mask(s.playerId)}`;
const assignBody = (playerId: string, role: string) => ({ role, player: false, participant: { player_id: playerId }, origin: 'manual' });

async function readStaff(t: string): Promise<Staff[]> {
  const res = await call('GET', recordsPath(t), { query: { player: false, 'role:null': false, page_size: 500 } });
  // Throws rather than `fail` (process.exit), so a probe's `finally` still restores.
  if (res.status !== 200) throw new Error(`Staff list → HTTP ${res.status}`);
  const body = res.body as { results?: unknown[]; next?: unknown };
  if (!Array.isArray(body.results)) throw new Error('Staff list has no results array');
  if (body.next) throw new Error('Staff list has more than one page of 500');
  return toStaff(body.results);
}

const startOf = (a: Record<string, unknown>) => String(a.start_date_v2 ?? a.start_date ?? '');

async function discover(): Promise<void> {
  heading('S6 · your tournaments (read-only)');
  const res = await call('GET', 'core/activities', {
    query: { type: 'tournament', role: 'organizer', sort_by: '-start_date', page_size: 20 },
  });
  writeSecretJson(RECORDING, recorded); // kept even if discover stops, so the raw rows can be inspected
  if (res.status !== 200) fail(`core/activities → HTTP ${res.status}`);
  const body = res.body as { count?: unknown; next?: unknown; results?: Record<string, unknown>[] };
  const rows = body.results ?? [];
  console.log(`  count=${String(body.count)} next=${body.next ? 'yes' : 'no'} rows=${rows.length}`);
  for (const a of rows) {
    const raw = (v: unknown) => JSON.stringify(v ?? null).slice(0, 60);
    console.log(`    ${a.display_id} · start_date=${raw(a.start_date)} · start_date_v2=${raw(a.start_date_v2)} · ${a.status}/${a.activity_state}`);
  }
  const items = rows
    .filter((a) => Date.parse(startOf(a)) <= Date.now())
    .sort((a, b) => Date.parse(startOf(b)) - Date.parse(startOf(a)));
  console.log(`  ${items.length} tournament(s) already started`);

  for (const a of items.slice(0, 5)) {
    const guid = String(a.guid ?? a.id);
    const staff = await readStaff(guid);
    console.log(`  ${a.display_id} · ${startOf(a)} · ${a.status} · staff: ${staff.map(show).join(', ')}`);
    const target = pickStaffer(staff);
    if (!target) continue;
    if (!withinAddWindow(startOf(a), new Date())) {
      fail(`The most recent tournament with 2+ staff (${a.display_id}) is past its 90-day add window; a re-add could be refused. Stopping.`);
    }
    const plan: Plan = { tournament: { guid, displayId: String(a.display_id), start: startOf(a) }, staffBefore: staff, target };
    writeSecretJson(PLAN_FILE, plan);
    writeSecretJson(RECORDING, recorded);
    console.log(`\nPlan: tournament ${a.display_id}, remove and restore the ${show(target)}.`);
    console.log(`Run the probe with: pnpm spike:s6-live probe --confirm ${guid.slice(-6)}`);
    return;
  }
  writeSecretJson(RECORDING, recorded);
  fail('None of the 5 most recent tournaments has 2+ staff including a non-organizer with an assignable role.');
}

async function probe(confirm: string | undefined): Promise<void> {
  const plan = readSecretJson<Plan>(PLAN_FILE) ?? fail('No plan. Run `pnpm spike:s6-live discover` first.');
  const t = plan.tournament.guid;
  if (confirm !== t.slice(-6)) fail('--confirm does not match the planned tournament. Nothing was written.');
  if (!withinAddWindow(plan.tournament.start, new Date())) fail('The tournament has left its add window. Nothing was written.');

  heading(`S6 · reads on tournament ${plan.tournament.displayId}`);
  await call('GET', `core/tournament/${t}`);
  const players = await call('GET', recordsPath(t), { query: { player: true, page: 1, page_size: 5 } });
  const next = (players.body as { next?: unknown }).next;
  if (typeof next === 'string') await call('GET', next);
  await call('GET', recordsPath(t), { query: { page: 1, page_size: 5 } });
  const day = Date.parse(plan.tournament.start);
  await call('GET', 'core/activities', {
    query: {
      type: 'tournament',
      role: 'organizer',
      'start_date_v2:greater_than_or_equal_to': new Date(day - 12 * 3_600_000).toISOString(),
      'start_date_v2:less_than_or_equal_to': new Date(day + 12 * 3_600_000).toISOString(),
    },
  });

  const before = await readStaff(t);
  const target = before.find((s) => s.recordId === plan.target.recordId && s.role === plan.target.role);
  if (!target?.role) fail('The planned staffer changed since discover. Nothing was written; run discover again.');
  const role = target.role;
  const staffer = { ...target, role };
  writeSecretJson(PLAN_FILE, { ...plan, staffBefore: before });

  heading(`S6 · WRITES (≥ ${WRITE_SPACING_MS / 1000} s apart): ${show(target)}`);
  try {
    const removed = await write('DELETE', recordPath(t, target.recordId), [{ legacy_alias: target.playerId }]);
    console.log(`  remove → ${removed.status}`);
    const added = await write('POST', recordsPath(t), assignBody(target.playerId, role));
    console.log(`  re-add as ${role} → ${added.status}`);
    const dup = await write('POST', recordsPath(t), assignBody(target.playerId, role));
    console.log(`  duplicate add → ${dup.status}`);

    const current = (await readStaff(t)).find((s) => s.playerId === target.playerId);
    if (current) {
      const changed = await write('PATCH', recordPath(t, current.recordId), [{ op: 'replace', path: '/role', value: otherRole(role) }]);
      console.log(`  change role to ${otherRole(role)} → ${changed.status}`);
      const back = await write('PATCH', recordPath(t, current.recordId), [{ op: 'replace', path: '/role', value: role }]);
      console.log(`  change role back to ${role} → ${back.status}`);
    }
    const invalid = await write('POST', recordsPath(t), assignBody(INVALID_PLAYER_ID, 'judge'));
    console.log(`  add player id "${INVALID_PLAYER_ID}" → ${invalid.status}`);
  } finally {
    await restore(t, before, staffer);
    writeSecretJson(RECORDING, recorded);
    console.log(`\nRecorded ${recorded.length} calls to ${RECORDING}. Next: pnpm spike:s6 ${RECORDING}`);
  }
}

/** Puts the staff list back to `before`: the staffer with their role, nothing extra. */
async function restore(t: string, before: Staff[], target: Staff & { role: string }): Promise<void> {
  heading('S6 · restore check');
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = repairActions(before, await readStaff(t), target, INVALID_PLAYER_ID);
      if (r.othersMissing.length) {
        console.log(`  ✗ Other staff are missing (${r.othersMissing.map(show).join(', ')}); the probe never touches them.`);
        break;
      }
      if (!r.add && !r.setRole && r.remove.length === 0) {
        console.log(`  ✓ RESTORED: the staff list matches the snapshot (${before.map(show).join(', ')})`);
        return;
      }
      if (r.add) await write('POST', recordsPath(t), assignBody(target.playerId, target.role));
      if (r.setRole) await write('PATCH', recordPath(t, r.setRole.recordId), [{ op: 'replace', path: '/role', value: r.setRole.role }]);
      for (const extra of r.remove) await write('DELETE', recordPath(t, extra.recordId), [{ legacy_alias: extra.playerId }]);
    }
    console.log(`\n  ✗✗ NOT RESTORED. Staff now: ${(await readStaff(t)).map(show).join(', ')}`);
  } catch (e) {
    console.log(`\n  ✗✗ RESTORE CHECK FAILED: ${(e as Error).message}`);
  }
  console.log(`  Re-add the ${show(target)} by hand in play-tools (Staff tab) with role "${target.role}".`);
  process.exitCode = 1;
}

run(async () => {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { confirm: { type: 'string' } } });
  if (positionals[0] === 'discover') return discover();
  if (positionals[0] === 'probe') return probe(values.confirm);
  fail('Usage: pnpm spike:s6-live discover | probe --confirm <code>');
});
