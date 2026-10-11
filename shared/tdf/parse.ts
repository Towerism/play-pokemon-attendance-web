import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { type PlayerId, type SessionDate, toPlayerId } from '../types/ids';
import { TDF_MAX_BYTES, TDF_MAX_PLAYERS } from './limits';

export { TDF_MAX_BYTES, TDF_MAX_PLAYERS };
/** Same limit as a typed player name (`shared/schemas/roster`). */
const NAME_MAX = 100;

export interface TdfPlayer {
  playerId: PlayerId;
  /** Empty when the file has no name for the player. */
  name: string;
}

export interface TdfTournament {
  name: string | null;
  /** The tournament's start date, when the file has a readable one. */
  date: SessionDate | null;
}

/** A row that can't be imported, kept so the preview can show it. */
export interface TdfInvalidRow {
  name: string;
  reason: string;
}

export interface ParsedTdf {
  tournament: TdfTournament;
  /** One entry per player ID, in file order. */
  players: TdfPlayer[];
  invalid: TdfInvalidRow[];
  /** Rows dropped because their ID was already listed. */
  duplicates: number;
}

export type TdfErrorCode = 'too_large' | 'unsafe' | 'not_tdf' | 'no_players' | 'too_many_players';

/** A file that can't be imported at all; `message` is meant for the organizer. */
export class TdfError extends Error {
  override name = 'TdfError';
  constructor(
    readonly code: TdfErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads the players out of a tournament file (`.tdf`, the XML that TOM writes).
 * Pure: no I/O. Keeps names and player IDs only; birthdates and every other
 * field are dropped here (architecture §9).
 * @throws TdfError
 */
export function parseTdf(xml: string): ParsedTdf {
  if (new TextEncoder().encode(xml).length > TDF_MAX_BYTES) {
    throw new TdfError('too_large', `The file is over ${TDF_MAX_BYTES / 1024 / 1024} MB; a tournament file is much smaller.`);
  }
  // DTDs are how XXE and billion-laughs payloads work, and TOM never writes one.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new TdfError('unsafe', 'The file declares a DOCTYPE or entities, which a tournament file never does.');
  }
  if (XMLValidator.validate(xml) !== true) throw notTdf();

  const doc = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    htmlEntities: false,
    isArray: (name) => name === 'player',
  }).parse(xml);
  const tournament = doc?.tournament;
  if (!tournament || typeof tournament !== 'object') throw notTdf();

  const rows: { userid?: unknown; firstname?: unknown; lastname?: unknown }[] = tournament.players?.player ?? [];
  if (rows.length > TDF_MAX_PLAYERS) {
    throw new TdfError('too_many_players', `The file lists ${rows.length} players; at most ${TDF_MAX_PLAYERS} can be imported.`);
  }

  const byId = new Map<PlayerId, TdfPlayer>();
  const invalid: TdfInvalidRow[] = [];
  let duplicates = 0;
  for (const row of rows) {
    const name = `${tidy(row.firstname)} ${tidy(row.lastname)}`.trim().slice(0, NAME_MAX).trimEnd();
    const playerId = asPlayerId(row.userid);
    if (!playerId) {
      invalid.push({ name, reason: 'Player ID must be 1–12 digits' });
      continue;
    }
    const seen = byId.get(playerId);
    if (!seen) byId.set(playerId, { playerId, name });
    else {
      duplicates++;
      if (!seen.name) seen.name = name;
    }
  }

  if (byId.size === 0) throw new TdfError('no_players', 'The file has no players with a valid player ID.');

  return {
    tournament: {
      name: tidy(tournament.data?.name) || null,
      date: usDate(tournament.data?.startdate),
    },
    players: [...byId.values()],
    invalid,
    duplicates,
  };
}

const notTdf = () => new TdfError('not_tdf', 'This is not a tournament file (.tdf).');

function asPlayerId(raw: unknown): PlayerId | null {
  if (typeof raw !== 'string') return null;
  try {
    return toPlayerId(raw);
  } catch {
    return null;
  }
}

const XML_ESCAPES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Entity processing is off in the parser, so only XML's five predefined
 * escapes and numeric character references are decoded, here. Anything else
 * stays as written.
 */
function unescapeXml(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));/gi, (whole, hex, dec, named) => {
    if (named) return XML_ESCAPES[named.toLowerCase()] ?? whole;
    const code = hex ? Number.parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function tidy(s: unknown): string {
  return typeof s === 'string' ? unescapeXml(s).replace(/\s+/g, ' ').trim() : '';
}

/** TOM writes `MM/DD/YYYY`. */
function usDate(s: unknown): SessionDate | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(tidy(s));
  if (!m) return null;
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso) ? (iso as SessionDate) : null;
}
