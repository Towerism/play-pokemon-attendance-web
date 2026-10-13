/**
 * Deterministic pseudonymisation of upstream responses so they can be
 * committed as contract fixtures (architecture §9: minors' PII).
 *
 * - person-ish keys (names, email, phone, birth dates, addresses) → "<redacted>"
 * - player ids → fake digits of the same length, stable within one Sanitizer
 * - GUIDs anywhere (ids, URLs) → 00000000-0000-4000-8000-<n>, stable; a dashless
 *   32-hex id (the user `sub`) gets the same fake without dashes
 * - JWTs → "<jwt>", emails anywhere → user@example.invalid
 * Dates, statuses and structure are preserved: S3 needs them.
 */

const PERSON_KEY =
  /^(name|title_name)$|(first|last|full|display|screen|user|nick|middle|given|family)_?name$|email|phone|birth|dob|address|avatar|guardian|parent/i;
/** What pins a venue on a map; state, country and timezone stay (dates need the zone). */
const LOCATION_KEY = /^(city|postal_?code|zip(_?code)?|place_?id|latitude|longitude|lat|lng|geo(location)?|coordinates)$/i;
/** A league's public id leads straight to the store. */
const LEAGUE_ID = /\bL\d{3,}\b/g;
const PLAYER_ID_KEY = /^(player_?id|pop_?id|playerid)$/i;
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const MESSAGE_KEY = /^(message|detail)$/i;
const ID_IN_TEXT = /(?<![\d-])\d{6,10}(?![\d-])/g;
const DASHLESS_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export class Sanitizer {
  private readonly guids = new Map<string, string>();
  private readonly playerIds = new Map<string, string>();
  private readonly leagues = new Map<string, string>();

  /** Original values that must not appear in any sanitized output. */
  get originals(): string[] {
    return [...this.guids.keys(), ...[...this.guids.keys()].map(undash), ...this.playerIds.keys(), ...this.leagues.keys()];
  }

  sanitize(value: unknown, key = ''): unknown {
    // Whole subtree, whatever its shape (e.g. an `address` object).
    if ((PERSON_KEY.test(key) || LOCATION_KEY.test(key)) && value !== null) return '<redacted>';
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
    // Upload errors name player ids in free text ("4589085 !== 4942060").
    const text = MESSAGE_KEY.test(key) ? value.replace(ID_IN_TEXT, (id) => this.fakePlayerId(id)) : value;
    return text
      .replace(EMAIL, 'user@example.invalid')
      .replace(GUID, (g) => this.fakeGuid(g))
      .replace(DASHLESS_ID, (h) => undash(this.fakeGuid(dash(h))))
      .replace(LEAGUE_ID, (l) => this.fakeLeague(l));
  }

  /**
   * Replaces every player id this sanitizer has seen wherever it appears in
   * free text (URL paths, error messages). Run it after `sanitize` has seen
   * all the bodies, so an id that appears before its key is still caught.
   */
  replaceKnownIds(text: string): string {
    let out = text;
    for (const [original, fake] of this.playerIds) {
      out = out.replace(new RegExp(`(?<!\\d)${original}(?!\\d)`, 'g'), fake);
    }
    return out;
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

  private fakeLeague(original: string): string {
    let fake = this.leagues.get(original);
    if (!fake) this.leagues.set(original, (fake = `L${900001 + this.leagues.size}`));
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

const undash = (guid: string) => guid.replace(/-/g, '');
const dash = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** Returns the originals that survived sanitisation (should be empty). */
export function findLeaks(sanitizedJson: string, originals: readonly string[]): string[] {
  const haystack = sanitizedJson.toLowerCase();
  return originals.filter((o) => o.length >= 4 && haystack.includes(o.toLowerCase()));
}
