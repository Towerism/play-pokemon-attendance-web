/**
 * Spike S6, certification: does upstream refuse a role the staffer isn't
 * certified for? THIS WRITES TO PLAY-TOOLS (only refused adds, if all goes as
 * expected). The organizer chose the person (TCG-certified only) and the VGC
 * tournament on 2026-10-11.
 *
 *   pnpm spike:s6-cert --tournament <display id> --player <id> [--role judge --role headjudge]
 *
 * Snapshots the staff list, tries each role (≥ 10 s apart), deletes any record
 * it added, and checks the staff list matches the snapshot.
 */
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { OP_API_BASE } from '../server/modules/pokemon/adapters/play-tools/constants';
import { fail, heading, run, sleep } from './lib/cli';
import type { ApiCall } from './lib/har';
import { op } from './lib/op';
import { RAW_DIR, writeSecretJson } from './lib/secrets';
import { addedFor, missingFrom, toStaff, type Staff } from './lib/staff';

const WRITE_SPACING_MS = 10_000;
const RECORDING = join(RAW_DIR, 's6-cert.json');
const recorded: ApiCall[] = [];

type Method = 'GET' | 'POST' | 'DELETE';
async function call(method: Method, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}) {
  const res = await op(method, path, opts);
  const url = new URL(path, OP_API_BASE);
  recorded.push({ method, path: url.pathname, query: opts.query ?? {}, status: res.status, request: opts.body ?? null, response: res.body });
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

const show = (s: Staff) => `${s.role} …${s.playerId.slice(-2)}`;

async function readStaff(t: string): Promise<Staff[]> {
  const res = await call('GET', `core/tournaments/${t}/records`, { query: { player: 'false', 'role:null': 'false', page_size: '500' } });
  const body = res.body as { results?: unknown[]; next?: unknown };
  if (res.status !== 200 || !Array.isArray(body.results) || body.next) throw new Error(`Staff list → HTTP ${res.status}`);
  return toStaff(body.results);
}

async function findTournament(displayId: string): Promise<{ guid: string; product: unknown; start: string }> {
  let path: string | undefined = 'core/activities';
  let query: Record<string, string> | undefined = { type: 'tournament', role: 'organizer', sort_by: '-start_date', page_size: '40' };
  for (let page = 0; path && page < 5; page++) {
    const body = (await call('GET', path, { query })).body as { next?: string; results: Record<string, unknown>[] };
    const hit = body.results.find((a) => a.display_id === displayId);
    if (hit) return { guid: String(hit.guid), product: hit.product, start: String(hit.start_date_v2) };
    path = body.next;
    query = undefined;
  }
  fail(`Tournament ${displayId} not found among the organizer's tournaments.`);
}

run(async () => {
  const { values: a } = parseArgs({ options: { tournament: { type: 'string' }, player: { type: 'string' }, role: { type: 'string', multiple: true } } });
  if (!a.tournament || !a.player || !/^\d+$/.test(a.player)) fail('--tournament <display id> and a numeric --player are required.');
  const playerId = a.player;
  const roles = a.role ?? ['judge', 'headjudge'];

  heading(`S6 cert · ${a.tournament}`);
  const { guid: t, product, start } = await findTournament(a.tournament);
  console.log(`  product ${JSON.stringify(product)} · start ${start}`);
  const before = await readStaff(t);
  console.log(`  staff: ${before.map(show).join(', ')}`);
  if (before.some((s) => s.playerId === playerId)) fail('The player is already on this tournament; a refusal would only say "duplicate". Nothing was written.');

  try {
    for (const role of roles) {
      const res = await write('POST', `core/tournaments/${t}/records`, { role, player: false, participant: { player_id: playerId }, origin: 'manual' });
      const errors = (res.body as { errors?: { body?: Record<string, { code?: string }[]> } })?.errors?.body ?? {};
      const codes = Object.entries(errors).flatMap(([k, v]) => v.map((e) => `${k}: ${e.code}`));
      console.log(`  add as ${role} → ${res.status} ${codes.join('; ')}`);
    }
  } finally {
    heading('S6 cert · restore check');
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const after = await readStaff(t);
        const added = addedFor(before, after, playerId);
        if (added.length === 0 && missingFrom(before, after).length === 0) {
          console.log(`  ✓ RESTORED: the staff list matches the snapshot (${before.map(show).join(', ')})`);
          break;
        }
        for (const r of added) await write('DELETE', `core/tournaments/${t}/records/${r.recordId}`, [{ legacy_alias: r.playerId }]);
        if (attempt === 3) console.log(`  ✗✗ NOT RESTORED. Remove …${playerId.slice(-2)} by hand in play-tools (Staff tab).`);
      }
    } catch (e) {
      console.log(`  ✗✗ RESTORE CHECK FAILED: ${(e as Error).message}`);
    }
    writeSecretJson(RECORDING, recorded);
    console.log(`\nRecorded ${recorded.length} calls to ${RECORDING}.`);
  }
});
