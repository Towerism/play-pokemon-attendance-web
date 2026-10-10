import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Store for spike credentials and raw upstream responses. Directories are
 * 0700 and files 0600. Nothing in here may be committed.
 *
 * Defaults to the gitignored `spikes/.secrets/`; the container points
 * `SPIKE_SECRETS_DIR` at a volume. There must be exactly ONE live copy of
 * tokens.json: refreshing from a stale copy replays a rotated token.
 */
export const SECRETS_DIR = process.env.SPIKE_SECRETS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.secrets');
export const RAW_DIR = join(SECRETS_DIR, 'raw');

export const paths = {
  pendingAuth: join(SECRETS_DIR, 'pending-auth.json'),
  tokens: join(SECRETS_DIR, 'tokens.json'),
  refreshLock: join(SECRETS_DIR, 'refresh.lock'),
  refreshLedger: join(SECRETS_DIR, 's2-ledger.jsonl'),
};

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function writeSecretJson(file: string, value: unknown): void {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function readSecretJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function appendSecretJsonl(file: string, value: unknown): void {
  ensureDir(dirname(file));
  appendFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
}

/** Short, non-reversible identifier for a token so logs can show rotation without leaking it. */
export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
