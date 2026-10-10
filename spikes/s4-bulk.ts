/**
 * Spike S4: `_bulk` semantics. THIS WRITES TO PLAY-TOOLS. Use a throwaway
 * play session you created for the purpose, and player ids whose owners agreed.
 *
 *   pnpm spike:s4 --group <groupId> --session <throwawaySessionId> --player <id> [--player <id> …] [--with-invalid]
 *
 * Steps (writes ≥ 15 s apart, as the CLI did):
 *   1. snapshot ALL records (any role)          The session creator already holds an organizer record.
 *   2. bulk-add every --player in ONE batch      → bulk-response.batch      (atomic if any item is rejected?)
 *   3. bulk-add each player not yet present      → bulk-response.single-<n> (success shape)
 *   4. bulk-add the first added player again     → bulk-response.repeat     (duplicate shape)
 *   5. --with-invalid: bulk-add ["not-a-player-id"] → bulk-response.invalid
 *   6. delete every record not in the step-1 snapshot, then verify the session matches it
 *
 * Findings from the first run (2026-10-10) are in docs/architecture/spikes.md · S4.
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
  player: boolean;
  role: string | null;
}

run(async () => {
  const { values: a } = parseArgs({
    options: {
      group: { type: 'string' },
      session: { type: 'string' },
      player: { type: 'string', multiple: true },
      'with-invalid': { type: 'boolean', default: false },
    },
  });
  if (!a.group || !a.session || !a.player?.length) fail('--group, --session and at least one --player are required.');
  const { group, session } = { group: a.group, session: a.session };
  const players = a.player;

  heading('S4 · snapshot (all roles)');
  const before = await listAll(group, session, 'before');
  for (const r of before) console.log(`  existing: player=${r.player} role=${r.role} target=${players.includes(r.playerId)}`);

  console.log(`\nAbout to WRITE to play session ${session} for ${players.length} player id(s), then remove what was added.`);
  const typed = await prompt(`Type the last 6 characters of the session id to proceed: `);
  if (typed !== session.slice(-6)) fail('Confirmation did not match. Nothing was written.');

  try {
    heading('S4 · one batch with every player');
    await bulk(group, session, players, 'batch');
    let current = await listAll(group, session, 'after-batch');
    report(players, before, current);

    let n = 0;
    for (const p of players.filter((p) => !current.some((r) => r.playerId === p))) {
      await sleep(WRITE_SPACING_MS);
      heading(`S4 · single add (${++n})`);
      await bulk(group, session, [p], `single-${n}`);
      current = await listAll(group, session, `after-single-${n}`);
      report([p], before, current);
    }

    const added = current.find((r) => !before.some((b) => b.recordId === r.recordId));
    if (added) {
      await sleep(WRITE_SPACING_MS);
      heading('S4 · repeat add of an added player');
      await bulk(group, session, [added.playerId], 'repeat');
      report([added.playerId], before, await listAll(group, session, 'after-repeat'));
    }

    if (a['with-invalid']) {
      await sleep(WRITE_SPACING_MS);
      heading('S4 · invalid id alone');
      await bulk(group, session, [INVALID_ID], 'invalid');
    }
  } finally {
    await cleanup(group, session, before);
  }
});

function report(players: string[], before: Rec[], current: Rec[]): void {
  for (const p of players) {
    const mine = current.filter((r) => r.playerId === p);
    const isNew = mine.filter((r) => !before.some((b) => b.recordId === r.recordId)).length;
    console.log(`  player …${p.slice(-3)}: ${mine.length} record(s), ${isNew} added by this probe`);
  }
}

async function bulk(group: string, session: string, ids: string[], label: string): Promise<void> {
  const res = await op('POST', opPaths.recordsBulk(group, session), {
    body: bulkRequestBody(ids),
    recordAs: { kind: 'bulk-response', label },
  });
  console.log(`    status ${res.status} · ${describeShape(res.body)}`);
  console.log(`    body: ${JSON.stringify(res.body).slice(0, 600)}`);
}

/** Every record regardless of role: `?player=true` hides the organizer's own record. */
async function listAll(group: string, session: string, label: string): Promise<Rec[]> {
  const out: Rec[] = [];
  for (let page = 1; page <= 40; page++) {
    const res = await op('GET', opPaths.records(group, session), {
      query: { page, page_size: 50 },
      recordAs: { kind: 'attendance-page', label: `s4.${label}.p${page}` },
    });
    if (res.status !== 200) fail(`Listing records failed (${res.status}); stopping before any further writes.`);
    const parsed = AttendancePage.safeParse(res.body);
    if (!parsed.success) fail('Attendance page did not match the wire schema; fix wire.ts from the raw file before running S4.');
    out.push(...parsed.data.items.map((r) => ({ recordId: r.recordId, playerId: r.participant.player_id, player: r.player, role: r.role })));
    if (!parsed.data.next) break;
  }
  return out;
}

async function cleanup(group: string, session: string, before: Rec[]): Promise<void> {
  heading('S4 · cleanup');
  const keep = new Set(before.map((r) => r.recordId));
  const added = (await listAll(group, session, 'before-cleanup')).filter((r) => !keep.has(r.recordId));
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
