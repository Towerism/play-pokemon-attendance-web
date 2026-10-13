/**
 * Turns a browser HAR (spike S6: the organizer's own DevTools capture) into
 * calls that can become contract fixtures. Headers and cookies are never
 * read, so tokens and session cookies cannot leak; only method, path, query,
 * status and JSON bodies are kept, then pseudonymised with `Sanitizer`.
 */
import { Sanitizer, findLeaks } from './sanitize';
import { summarizeTdf } from './tdf-summary';

export interface ApiCall {
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  request: unknown;
  response: unknown;
}

interface HarEntry {
  request: { method: string; url: string; postData?: { mimeType?: string; text?: string } };
  response: { status: number; content?: { mimeType?: string; text?: string; encoding?: string } };
}

const SEARCH_KEY = /^(q|query|search|term|keyword)$/i;

export function apiCalls(har: unknown, host = 'api.play.pokemon.com'): ApiCall[] {
  const entries = (har as { log?: { entries?: unknown } })?.log?.entries;
  if (!Array.isArray(entries)) throw new Error('Input is not a HAR (no log.entries)');
  return (entries as HarEntry[])
    .filter((e) => new URL(e.request.url).host === host && e.request.method !== 'OPTIONS')
    .map((e) => {
      const url = new URL(e.request.url);
      const content = e.response.content ?? {};
      const text = content.encoding === 'base64' ? Buffer.from(content.text ?? '', 'base64').toString('utf8') : (content.text ?? '');
      return {
        method: e.request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        status: e.response.status,
        request: body(e.request.postData?.text ?? '', e.request.postData?.mimeType),
        response: body(text, content.mimeType),
      };
    });
}

function body(text: string, mimeType = ''): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return { nonJson: mimeType || 'unknown', bytes: Buffer.byteLength(text) };
  }
}

/** A HAR, or the list of calls `spikes/s6-live.ts` recorded. */
export function loadCalls(json: unknown): ApiCall[] {
  if (!Array.isArray(json)) return apiCalls(json);
  return json.map((c: Partial<ApiCall>) => {
    if (typeof c?.method !== 'string' || typeof c.path !== 'string' || typeof c.status !== 'number') {
      throw new Error('Input list item is not a recorded call (method, path, status)');
    }
    return c as ApiCall;
  });
}

export interface SanitizeOptions {
  /** Real ids collected during a run (sub, league, display ids…); any survivor blocks the write. */
  knownOriginals?: readonly string[];
}

/** Pseudonymises all calls with one Sanitizer, so ids stay consistent across them. */
export function sanitizeCalls(input: readonly ApiCall[], opts: SanitizeOptions = {}): { calls: ApiCall[]; leaks: string[] } {
  const s = new Sanitizer();
  const calls = input.map((c) => ({ ...c, request: redactFiles(c.request), response: redactFiles(c.response) }));
  const firstPass = calls.map((c) => ({
    ...c,
    query: Object.fromEntries(
      Object.entries(s.sanitize(c.query) as Record<string, string>).map(([k, v]) => [k, SEARCH_KEY.test(k) ? '<redacted>' : v]),
    ),
    request: s.sanitize(c.request),
    response: s.sanitize(c.response),
  }));
  // Second pass: ids seen under a player-id key anywhere replace their
  // occurrences in paths and free text (error messages) everywhere.
  const out = firstPass.map((c) => ({
    ...c,
    path: s.replaceKnownIds(s.sanitize(c.path) as string),
    query: JSON.parse(s.replaceKnownIds(JSON.stringify(c.query))) as Record<string, string>,
    request: JSON.parse(s.replaceKnownIds(JSON.stringify(c.request))) as unknown,
    response: JSON.parse(s.replaceKnownIds(JSON.stringify(c.response))) as unknown,
  }));
  const events = pseudonymiseEvents(out);
  const originals = [...s.originals, ...events.originals, ...(opts.knownOriginals ?? [])];
  return { calls: events.calls, leaks: [...new Set(findLeaks(JSON.stringify(events.calls), originals))] };
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MIN_ENCODED_FILE = 256;

/**
 * A TDF (raw XML or base64) becomes its summary: names and birthdates inside it
 * are invisible to key-based redaction. Any other long base64 string could be an
 * encoded file too, so it is dropped with its size.
 */
function redactFiles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFiles);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactFiles(v)]));
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const encoded = trimmed.length >= MIN_ENCODED_FILE && BASE64.test(trimmed);
  if (!encoded && !trimmed.startsWith('<')) return value;
  try {
    return summarizeTdf(value);
  } catch {
    return encoded ? { base64: '<redacted>', bytes: Buffer.from(trimmed, 'base64').length } : value;
  }
}

/** Event free text and store websites identify a place and its people. */
const EVENT_TEXT_KEY = /^(details|event_website|website|third_party_registration_website|admin_notes)$/i;
/** A public tournament id ("26-10-010393") leads straight to the real event. */
const TOURNAMENT_DISPLAY_ID = /\b(\d{2}-\d{2}-)(\d{6})\b/g;

function pseudonymiseEvents(calls: ApiCall[]): { calls: ApiCall[]; originals: string[] } {
  const fakes = new Map<string, string>();
  const redact = (v: unknown, key = ''): unknown => {
    if (EVENT_TEXT_KEY.test(key) && typeof v === 'string') return '<redacted>';
    if (Array.isArray(v)) return v.map((x) => redact(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
    return v;
  };
  const json = JSON.stringify(redact(calls)).replace(TOURNAMENT_DISPLAY_ID, (id: string, prefix: string) => {
    let fake = fakes.get(id);
    if (!fake) fakes.set(id, (fake = `${prefix}${900001 + fakes.size}`));
    return fake;
  });
  return { calls: JSON.parse(json) as ApiCall[], originals: [...fakes.keys()] };
}
