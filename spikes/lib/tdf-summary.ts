/**
 * Spike S8: what a TDF may say about itself outside `.secrets/`. A TDF holds
 * minors' names and birthdates, and it travels base64-encoded (upload body,
 * download response), where key-based redaction can't see it. Fixtures carry
 * only `summarizeTdf`; `readTdfHeader` is for the local pre-upload check.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export interface TdfSummary {
  tdf: '<redacted>';
  bytes: number;
  gametype: string;
  elements: string[];
}

export interface TdfHeader {
  tournamentId: string;
  organizerId: string;
  gametype: string;
}

const ATTR = '@_';

/** The decoded file, untrimmed (its size is reported as is). */
function toXml(input: string): string {
  const trimmed = input.trim();
  const xml = trimmed.startsWith('<') ? input : Buffer.from(trimmed, 'base64').toString('utf8');
  if (!xml.trimStart().startsWith('<')) throw new Error('Input is not a TDF (neither XML nor base64 XML)');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('The TDF declares a DOCTYPE or entities; refusing to read it');
  if (XMLValidator.validate(xml.trim()) !== true) throw new Error('Input is not a TDF (invalid XML)');
  return xml;
}

function tournamentOf(xml: string): Record<string, unknown> {
  const doc = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    htmlEntities: false,
  }).parse(xml.trim()) as { tournament?: unknown };
  if (!doc.tournament || typeof doc.tournament !== 'object') throw new Error('Input is not a TDF (no <tournament> root)');
  return doc.tournament as Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Accepts the raw XML or its base64. */
export function summarizeTdf(input: string): TdfSummary {
  const xml = toXml(input);
  const t = tournamentOf(xml);
  return {
    tdf: '<redacted>',
    bytes: Buffer.byteLength(xml),
    gametype: str(t[`${ATTR}gametype`]),
    elements: ['tournament', ...Object.keys(t).filter((k) => !k.startsWith(ATTR))],
  };
}

export function readTdfHeader(input: string): TdfHeader {
  const t = tournamentOf(toXml(input));
  const data = (t.data ?? {}) as Record<string, unknown>;
  const organizer = (data.organizer ?? {}) as Record<string, unknown>;
  return { tournamentId: str(data.id), organizerId: str(organizer[`${ATTR}popid`]), gametype: str(t[`${ATTR}gametype`]) };
}
