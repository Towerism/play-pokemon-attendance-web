/**
 * Deterministic pseudonymisation of upstream responses so they can be
 * committed as contract fixtures (architecture §9: minors' PII).
 *
 * - person-ish keys (names, email, phone, birth dates, addresses) → "<redacted>"
 * - player ids → fake digits of the same length, stable within one Sanitizer
 * - GUIDs anywhere (ids, URLs) → 00000000-0000-4000-8000-<n>, stable
 * - JWTs → "<jwt>", emails anywhere → user@example.invalid
 * Dates, statuses and structure are preserved: S3 needs them.
 */

const PERSON_KEY =
  /^(name|title_name)$|(first|last|full|display|screen|user|nick|middle|given|family)_?name$|email|phone|birth|dob|address|avatar|guardian|parent/i;
const PLAYER_ID_KEY = /^(player_?id|pop_?id|playerid)$/i;
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export class Sanitizer {
  private readonly guids = new Map<string, string>();
  private readonly playerIds = new Map<string, string>();

  /** Original values that must not appear in any sanitized output. */
  get originals(): string[] {
    return [...this.guids.keys(), ...this.playerIds.keys()];
  }

  sanitize(value: unknown, key = ''): unknown {
    // Whole subtree, whatever its shape (e.g. an `address` object).
    if (PERSON_KEY.test(key) && value !== null) return '<redacted>';
    if (Array.isArray(value)) return value.map((v) => this.sanitize(v, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.sanitize(v, k)]));
    }
    if (PLAYER_ID_KEY.test(key) && (typeof value === 'string' || typeof value === 'number')) {
      const fake = this.fakePlayerId(String(value));
      return typeof value === 'number' ? Number(fake) : fake;
    }
    if (typeof value !== 'string') return value;
    if (JWT.test(value)) return '<jwt>';
    return value.replace(EMAIL, 'user@example.invalid').replace(GUID, (g) => this.fakeGuid(g));
  }

  private fakeGuid(original: string): string {
    const k = original.toLowerCase();
    let fake = this.guids.get(k);
    if (!fake) {
      fake = `00000000-0000-4000-8000-${String(this.guids.size + 1).padStart(12, '0')}`;
      this.guids.set(k, fake);
    }
    return fake;
  }

  private fakePlayerId(original: string): string {
    let fake = this.playerIds.get(original);
    if (!fake) {
      const n = String(this.playerIds.size + 1);
      fake = '9'.repeat(Math.max(0, original.length - n.length)) + n;
      this.playerIds.set(original, fake);
    }
    return fake;
  }
}

/** Returns the originals that survived sanitisation (should be empty). */
export function findLeaks(sanitizedJson: string, originals: readonly string[]): string[] {
  const haystack = sanitizedJson.toLowerCase();
  return originals.filter((o) => o.length >= 4 && haystack.includes(o.toLowerCase()));
}
