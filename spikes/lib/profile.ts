/**
 * S7: where does the professor's name live? Describes a profile payload
 * (`/me`, id_token claims) as leaf paths and types only, so the output can be
 * pasted into an issue. Name-like fields show their first letter and length.
 */

const NAME_KEY = /name/i;

export function profileReport(label: string, body: unknown): string[] {
  const lines: string[] = [];
  walk(label, '', body, lines);
  return lines;
}

function walk(path: string, key: string, value: unknown, lines: string[]): void {
  if (Array.isArray(value)) {
    lines.push(`${path}: array(${value.length})`);
    if (value.length) walk(`${path}[0]`, key, value[0], lines);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(`${path}.${k}`, k, v, lines);
    return;
  }
  lines.push(`${path}: ${describe(key, value)}`);
}

/** A request line for pasteable output: each secret (the account `sub`) is replaced by `<sub>`. */
export function maskedRequestLine(method: string, pathAndQuery: string, status: number, secrets: readonly string[]): string {
  const masked = secrets.reduce((line, secret) => (secret ? line.split(secret).join('<sub>') : line), pathAndQuery);
  return `${method} ${masked} → ${status}`;
}

function describe(key: string, value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'string') return typeof value;
  if (NAME_KEY.test(key) && value.length) return `name "${value[0]}…" (${value.length} chars)`;
  return `string(${value.length})`;
}
