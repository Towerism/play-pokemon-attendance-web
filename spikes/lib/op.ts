import { join } from 'node:path';
import { OP_API_BASE, OP_API_HEADERS } from '../../server/modules/pokemon/adapters/play-tools/constants';
import { FIXTURE_SCHEMAS, type FixtureKind } from '../../server/modules/pokemon/adapters/play-tools/wire';
import { sleep } from './cli';
import { RAW_DIR, writeSecretJson } from './secrets';
import { getAccessToken } from './tokens';

/** Minimum spacing between OP API reads: human-like, never bursty. */
const READ_SPACING_MS = 1_500;
let lastCallAt = 0;

export interface OpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export interface RecordAs {
  kind: FixtureKind | 'misc';
  label: string;
}

const KEPT_HEADERS = /^(content-type|retry-after|x-ratelimit-.*|ratelimit.*|x-request-id|x-amzn-requestid|date)$/i;

/**
 * One call to the OP gateway with the minimal header set. The raw response
 * is written to `.secrets/raw/<kind>.<label>.json` (gitignored; sanitize
 * before committing) and, for known kinds, validated against the wire schema.
 */
export async function op(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  /** `quiet`: don't print the request line (the caller prints a masked one). */
  opts: { query?: Record<string, string | number>; body?: unknown; recordAs?: RecordAs; quiet?: boolean } = {},
): Promise<OpResponse> {
  const wait = lastCallAt + READ_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);

  const url = new URL(path, OP_API_BASE);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));

  const token = await getAccessToken();
  const res = await fetch(url, {
    method,
    headers: {
      ...OP_API_HEADERS,
      authorization: `Bearer ${token.access_token}`,
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  lastCallAt = Date.now();

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  const headers = Object.fromEntries([...res.headers].filter(([k]) => KEPT_HEADERS.test(k)));
  const result: OpResponse = { status: res.status, body, headers };

  if (!opts.quiet) console.log(`  ${method} ${url.pathname}${url.search} → ${res.status}`);

  if (opts.recordAs) {
    const file = join(RAW_DIR, `${opts.recordAs.kind}.${opts.recordAs.label}.json`);
    writeSecretJson(file, { request: { method, url: url.toString(), body: opts.body }, ...result });
    if (opts.recordAs.kind !== 'misc' && res.ok) reportValidation(opts.recordAs.kind, body);
  }
  return result;
}

export function reportValidation(kind: FixtureKind, body: unknown): boolean {
  const parsed = FIXTURE_SCHEMAS[kind].safeParse(body);
  if (parsed.success) {
    console.log(`    ✓ matches provisional ${kind} schema`);
    return true;
  }
  console.log(`    ✗ does NOT match provisional ${kind} schema:`);
  for (const issue of parsed.error.issues.slice(0, 8)) {
    console.log(`      - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  return false;
}

/** Top-level keys and the keys of the first list item: enough to see a shape at a glance. */
export function describeShape(body: unknown): string {
  if (!body || typeof body !== 'object') return typeof body;
  const top = Object.keys(body);
  const list = (body as Record<string, unknown>).results ?? (body as Record<string, unknown>).data;
  const first = Array.isArray(list) ? list[0] : Array.isArray(body) ? body[0] : undefined;
  const item = first && typeof first === 'object' ? ` · item keys: ${Object.keys(first).join(', ')}` : '';
  return `${Array.isArray(body) ? `array(${body.length})` : `keys: ${top.join(', ')}`}${item}`;
}
