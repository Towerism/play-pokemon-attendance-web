/**
 * Spike S2: refresh-token lifetime and rotation.
 *
 *   pnpm spike:s2                 refresh once (run daily for ~7 days)
 *   pnpm spike:s2 report          summarise the ledger
 *   pnpm spike:s2 probe-reuse     LAST STEP ONLY: replay the previous refresh
 *                                 token to see whether Hydra revokes the chain
 *
 * Every attempt is appended to .secrets/s2-ledger.jsonl (fingerprints only).
 */
import { confirm, fail, heading, run } from './lib/cli';
import { fingerprint, paths } from './lib/secrets';
import { type RefreshOutcome, OAuthError, loadTokens, refreshTokens } from './lib/tokens';
import { existsSync, readFileSync } from 'node:fs';

run(async () => {
  const cmd = process.argv[2] ?? 'refresh';
  if (cmd === 'refresh') return refreshOnce();
  if (cmd === 'report') return report();
  if (cmd === 'probe-reuse') return probeReuse();
  fail(`Unknown command ${cmd}`);
});

async function refreshOnce(): Promise<void> {
  const before = loadTokens();
  heading('S2 · refresh');
  try {
    const after = await refreshTokens(process.env.S2_TRIGGER ?? 'manual');
    console.log({
      rotated: after.refresh_token !== before.refresh_token,
      old_fp: fingerprint(before.refresh_token),
      new_fp: fingerprint(after.refresh_token),
      access_expires_at: after.expires_at,
      hours_since_previous_token: hoursBetween(before.obtained_at, after.obtained_at),
    });
  } catch (err) {
    if (err instanceof OAuthError) fail(`Refresh rejected: ${err.message}. Record the age of the chain in spikes.md.`);
    throw err;
  }
}

function report(): void {
  if (!existsSync(paths.refreshLedger)) fail('Ledger is empty.');
  const rows = readFileSync(paths.refreshLedger, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as RefreshOutcome);
  const ok = rows.filter((r) => r.ok);
  const first = rows[0]!;
  const lastOk = ok.at(-1);
  heading('S2 · ledger report');
  console.log('last 24 attempts:');
  console.table(rows.slice(-24).map((r) => ({ at: r.at, trigger: r.trigger, ok: r.ok, rotated: r.rotated, expires_in: r.expires_in, error: r.error })));
  const gaps = ok.slice(1).map((r, i) => hoursBetween(ok[i]!.at, r.at));
  console.log({
    attempts: rows.length,
    successes: ok.length,
    failures: rows.length - ok.length,
    by_trigger: Object.fromEntries([...new Set(rows.map((r) => r.trigger))].map((t) => [t, rows.filter((r) => r.trigger === t).length])),
    longest_gap_between_successes_h: gaps.length ? Math.max(...gaps) : 0,
    always_rotated: ok.length > 0 && ok.every((r) => r.rotated),
    access_token_expires_in_s: [...new Set(ok.map((r) => r.expires_in))],
    chain_age_days_at_last_success: lastOk ? hoursBetween(first.at, lastOk.at) / 24 : 0,
    first_failure: rows.find((r) => !r.ok) ?? null,
  });
}

async function probeReuse(): Promise<void> {
  const t = loadTokens();
  if (!t.previous_refresh_token) fail('No previous refresh token stored. Run at least one refresh first.');
  heading('S2 · reuse probe');
  console.log(`This replays an already-rotated refresh token (fp ${fingerprint(t.previous_refresh_token)}).
If Hydra has reuse detection, BOTH the old and current chain are revoked and you
must run \`pnpm spike:s1\` again before S3/S4. Run this only after the TTL observations.`);
  if (!(await confirm('Proceed?'))) return;

  let replay: string;
  try {
    await refreshTokens('probe-reuse:old', { override: { ...t, refresh_token: t.previous_refresh_token } });
    replay = 'ACCEPTED (no rotation enforcement!)';
  } catch (err) {
    replay = err instanceof OAuthError ? `rejected: ${err.message}` : String(err);
  }
  let current: string;
  try {
    await refreshTokens('probe-reuse:current');
    current = 'still valid → no chain revocation on reuse';
  } catch (err) {
    current = err instanceof OAuthError ? `rejected: ${err.message} → chain revoked on reuse` : String(err);
  }
  console.log({ replay_old_token: replay, current_token_after_replay: current });
}

function hoursBetween(a: string, b: string): number {
  return Math.round(((Date.parse(b) - Date.parse(a)) / 3_600_000) * 10) / 10;
}
