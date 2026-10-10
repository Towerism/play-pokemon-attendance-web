/**
 * Spike S4: `_bulk` semantics. THIS WRITES TO PLAY-TOOLS. Use a throwaway
 * play session you created for the purpose, and a player id that belongs to
 * you (or someone who agreed).
 *
 *   pnpm spike:s4 --group <groupId> --session <throwawaySessionId> --player <playerId> [--with-invalid]
 *
 * Steps (writes ≥ 15 s apart, as the CLI did):
 *   1. snapshot existing records            (abort if --player already present)
 *   2. bulk-add [player]                    → bulk-response.first
 *   3. bulk-add [player] again              → bulk-response.duplicate  (error? no-op? second record?)
 *   4. --with-invalid: bulk-add [player, "not-a-player-id"] → bulk-response.mixed (partial failure shape)
 *   5. delete every record not in the step-1 snapshot, then verify the session matches the snapshot
 */
import { parseArgs } from 'node:util';
import { opPaths } from '../server/modules/pokemon/adapters/play-tools/constants';
import { AttendancePage, bulkRequestBody } from '../server/modules/pokemon/adapters/play-tools/wire';
import { fail, heading, prompt, run, sleep } from './lib/cli';
import { describeShape, op } from './lib/op';

const WRITE_SPACING_MS = 15_000;
const INVALID_ID = 'not-a-player-id';

interface Rec {
  recordId: string;
  playerId: string;
}

run(async () => {
  const { values: a } = parseArgs({
    options: {
      group: { type: 'string' },
      session: { type: 'string' },
      player: { type: 'string' },
      'with-invalid': { type: 'boolean', default: false },
    },
  });
  if (!a.group || !a.session || !a.player) fail('--group, --session and --player are required.');
  const { group, session, player } = { group: a.group, session: a.session, player: a.player };

  heading('S4 · snapshot');
  const before = await listAll(group, session, 'before');
  console.log(`  ${before.length} existing record(s)`);
  if (before.some((r) => r.playerId === player)) fail(`Player ${player} is already in this session. Pick a session/player pair where they are absent.`);

  console.log(`\nAbout to WRITE to play session ${session}: add player ${player} (twice${a['with-invalid'] ? ', then a mixed batch' : ''}), then remove what was added.`);
  const typed = await prompt(`Type the last 6 characters of the session id to proceed: `);
  if (typed !== session.slice(-6)) fail('Confirmation did not match. Nothing was written.');

  try {
    heading('S4 · bulk add (first)');
    await bulk(group, session, [player], 'first');
    const afterFirst = await listAll(group, session, 'after-first');
    console.log(`  records for player: ${afterFirst.filter((r) => r.playerId === player).length}`);

    await sleep(WRITE_SPACING_MS);
    heading('S4 · bulk add (duplicate)');
    await bulk(group, session, [player], 'duplicate');
    const afterDup = await listAll(group, session, 'after-duplicate');
    console.log(`  records for player after duplicate add: ${afterDup.filter((r) => r.playerId === player).length}`);

    if (a['with-invalid']) {
      await sleep(WRITE_SPACING_MS);
      heading('S4 · bulk add (mixed valid + invalid)');
      await bulk(group, session, [player, INVALID_ID], 'mixed');
      await listAll(group, session, 'after-mixed');
    }
  } finally {
    await cleanup(group, session, before);
  }
});

async function bulk(group: string, session: string, ids: string[], label: string): Promise<void> {
  const res = await op('POST', opPaths.recordsBulk(group, session), {
    body: bulkRequestBody(ids),
    recordAs: { kind: 'bulk-response', label },
  });
  console.log(`    status ${res.status} · ${describeShape(res.body)}`);
  console.log(`    body: ${JSON.stringify(res.body).slice(0, 600)}`);
}

async function listAll(group: string, session: string, label: string): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await op('GET', opPaths.records(group, session), {
      query: { player: 'true', page, page_size: 50 },
      recordAs: { kind: 'attendance-page', label: `s4.${label}.p${page}` },
    });
    if (res.status !== 200) fail(`Listing records failed (${res.status}); stopping before any further writes.`);
    const parsed = AttendancePage.safeParse(res.body);
    if (!parsed.success) fail('Attendance page did not match the provisional schema; fix wire.ts from the raw file before running S4.');
    out.push(...parsed.data.items.map((r) => ({ recordId: r.recordId, playerId: r.participant.player_id })));
    if (parsed.data.items.length < 50 && !parsed.data.next) break;
  }
  return out;
}

async function cleanup(group: string, session: string, before: Rec[]): Promise<void> {
  heading('S4 · cleanup');
  const keep = new Set(before.map((r) => r.recordId));
  const current = await listAll(group, session, 'before-cleanup');
  const added = current.filter((r) => !keep.has(r.recordId));
  for (const r of added) {
    const res = await op('DELETE', opPaths.record(group, session, r.recordId), {
      recordAs: { kind: 'misc', label: `s4.delete.${r.recordId.slice(0, 8)}` },
    });
    if (res.status >= 300) console.log(`    ✗ delete failed: ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  const final = await listAll(group, session, 'final');
  const restored = final.length === before.length && final.every((r) => keep.has(r.recordId));
  console.log(restored ? '  ✓ session restored to snapshot' : `  ✗ session differs from snapshot (${final.length} vs ${before.length}); check play-tools manually`);
}
