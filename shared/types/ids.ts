/**
 * Pokémon Player ID. Opaque digits kept as a string so leading zeros survive
 * (see architecture §5, "player_id is TEXT").
 */
export type PlayerId = string & { readonly __brand: 'PlayerId' };

/** Calendar date in the league timezone, `YYYY-MM-DD`. */
export type SessionDate = string & { readonly __brand: 'SessionDate' };

const PLAYER_ID = /^\d{1,12}$/;
const SESSION_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function toPlayerId(raw: string | number): PlayerId {
  const s = String(raw).trim();
  if (!PLAYER_ID.test(s)) throw new TypeError(`Invalid player id: ${JSON.stringify(raw)}`);
  return s as PlayerId;
}

export function toSessionDate(raw: string): SessionDate {
  if (!SESSION_DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw new TypeError(`Invalid session date: ${JSON.stringify(raw)}`);
  }
  return raw as SessionDate;
}
