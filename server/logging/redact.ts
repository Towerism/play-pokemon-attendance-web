/**
 * Log redaction (architecture §10, CLAUDE.md security musts): no token,
 * password, cookie or birthdate value may reach the log. Runs before either
 * formatter, so pretty and JSON output are equally safe.
 *
 * Keys match an exact list after normalizing (lowercase, `_`/`-` removed), so
 * `refresh_token` and `refreshToken` are hidden but `tokenCount` is not.
 */

export const REDACTED = '[REDACTED]';

export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'sessionpassword',
  'nuxtsessionpassword',
  'secret',
  'clientsecret',
  'secretaccesskey',
  'litestreamsecretaccesskey',
  'tokenvaultkey',
  'nuxttokenvaultkey',
  'tdfvaultkey',
  'nuxttdfvaultkey',
  'codeverifier',
  'authorizationcode',
  'birthdate',
  'dateofbirth',
  'dob',
  // A TDF's body holds every player's birthdate (ADR-0012).
  'content',
  'payload',
]);

const MAX_DEPTH = 8;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

// A value runs to whitespace, `&`, `,`, `;`, `"` or the end of the string.
const BEARER = /\b(bearer\s+)[^\s&,;"]+/gi;
const NAME_VALUE = /([A-Za-z_-]+)(=|":")([^\s&,;"]*)/g;

/** Hides credential-looking substrings: `Bearer …`, `name=…`, `"name":"…"`. */
export function scrub(text: string): string {
  return text
    .replace(BEARER, `$1${REDACTED}`)
    .replace(NAME_VALUE, (whole, name: string, sep: string, value: string) =>
      value && isSensitiveKey(name) ? `${name}${sep}${REDACTED}` : whole,
    );
}

/** A deep, redacted copy of `value`; never throws and never mutates the input. */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen));
    const out: Record<string, unknown> = {};
    if (value instanceof Error) {
      out.type = value.name;
      out.message = scrub(value.message);
      if (value.stack) out.stack = scrub(value.stack);
      if (value.cause !== undefined) out.cause = walk(value.cause, depth + 1, seen);
    }
    for (const key of Object.keys(value)) {
      out[key] = field(value as Record<string, unknown>, key, depth, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function field(obj: Record<string, unknown>, key: string, depth: number, seen: WeakSet<object>): unknown {
  let raw: unknown;
  try {
    raw = obj[key];
  } catch {
    return '[Unserializable]';
  }
  if (raw !== null && raw !== undefined && isSensitiveKey(key)) return REDACTED;
  return walk(raw, depth + 1, seen);
}
