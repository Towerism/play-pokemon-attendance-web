import { type ParsedTdf, TdfError, type TdfOrganizer, parseTdf } from './parse';

export type TdfCorrectionSkip = 'not_empty' | 'invalid_value' | 'unexpected_shape' | 'recheck_failed';

type Skipped = { applied: false; reason: TdfCorrectionSkip };

export interface TdfCorrectionRequest {
  /** The tournament's display id, filled in only when the file's id is empty. */
  tournamentId?: string;
  /** The tournament's organizer: player id and full name. */
  organizer?: { playerId: string; name: string };
}

export interface TdfCorrectionResult {
  /** The corrected file, or the input unchanged when nothing was applied. */
  xml: string;
  /** Present only when `tournamentId` was requested. */
  tournamentId?: { applied: true } | Skipped;
  /** Present only when `organizer` was requested; `previous` is the organizer the file named. */
  organizer?: { applied: true; previous: TdfOrganizer | null } | Skipped;
}

const DISPLAY_ID = /^\d{2}-\d{2}-\d{6}$/;
const PLAYER_ID = /^\d{1,12}$/;
/** Same limit as a typed player name and the professor's full name. */
const NAME_MAX = 100;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Fixes what ADR-0011 decision 8 lets the app fix in a TDF, as a minimal text edit: every character outside the
 * edited values stays as TOM wrote it, never re-serialised. The id goes first, then the organizer; each is parsed
 * again to check it, and is dropped (with a reason) when it can't be made safely. Pure: no I/O.
 * @throws TdfError when the input isn't a readable tournament file (the same codes as parseTdf)
 */
export function correctTdf(xml: string, request: TdfCorrectionRequest): TdfCorrectionResult {
  let parsed = parseTdf(xml);
  const result: TdfCorrectionResult = { xml };

  const apply = (edit: Edit, expected: (p: ParsedTdf) => ParsedTdf): Skipped | null => {
    if ('reason' in edit) return { applied: false, reason: edit.reason };
    const after = reparse(edit.xml);
    if (!after || JSON.stringify(after) !== JSON.stringify(expected(parsed))) return { applied: false, reason: 'recheck_failed' };
    result.xml = edit.xml;
    parsed = after;
    return null;
  };

  const { tournamentId, organizer } = request;
  if (tournamentId !== undefined) {
    result.tournamentId =
      apply(fillTournamentId(result.xml, tournamentId), (p) => ({ ...p, header: { ...p.header, tournamentId } })) ??
      { applied: true };
  }
  if (organizer !== undefined) {
    const previous = parsed.header.organizer;
    const expected = { playerId: organizer.playerId, name: organizer.name.replace(/\s+/g, ' ').trim() };
    result.organizer =
      apply(replaceOrganizer(result.xml, organizer), (p) => ({ ...p, header: { ...p.header, organizer: expected } })) ??
      { applied: true, previous };
  }
  return result;
}

type Edit = { xml: string } | { reason: TdfCorrectionSkip };

function fillTournamentId(xml: string, tournamentId: string): Edit {
  if (!DISPLAY_ID.test(tournamentId)) return { reason: 'invalid_value' };
  const at = onlyTagIn(xml, 'id');
  if (at === null) return { reason: 'unexpected_shape' };
  const element = /<id\s*\/>|<id\s*>([^<]*)<\/id\s*>/y;
  element.lastIndex = at;
  const m = element.exec(xml);
  if (!m) return { reason: 'unexpected_shape' };
  if ((m[1] ?? '').trim()) return { reason: 'not_empty' };
  return { xml: splice(xml, at, at + m[0].length, `<id>${tournamentId}</id>`) };
}

function replaceOrganizer(xml: string, { playerId, name }: { playerId: string; name: string }): Edit {
  if (!PLAYER_ID.test(playerId) || !name.trim() || name.length > NAME_MAX || CONTROL.test(name)) return { reason: 'invalid_value' };
  const at = onlyTagIn(xml, 'organizer');
  if (at === null) return { reason: 'unexpected_shape' };
  const startTag = /<organizer[^>]*>/y;
  startTag.lastIndex = at;
  const tag = startTag.exec(xml)![0];

  const values = new Map<string, { start: number; end: number }[]>();
  for (const m of tag.matchAll(/\s([A-Za-z_:][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    // The value sits between the quotes, at the end of the match.
    const end = at + m.index + m[0].length - 1;
    const start = end - (m[2] ?? m[3] ?? '').length;
    values.set(m[1]!, [...(values.get(m[1]!) ?? []), { start, end }]);
  }
  const popid = values.get('popid');
  const nameAt = values.get('name');
  if (popid?.length !== 1 || nameAt?.length !== 1) return { reason: 'unexpected_shape' };

  // Right to left, so the earlier offset still holds after the later edit.
  const edits = [
    { ...popid[0]!, text: playerId },
    { ...nameAt[0]!, text: escapeAttr(name) },
  ].sort((a, b) => b.start - a.start);
  return { xml: edits.reduce((out, e) => splice(out, e.start, e.end, e.text), xml) };
}

/** Where the single `<name …>` start tag inside the file's single, plain `<data>` begins, or null. */
function onlyTagIn(xml: string, name: string): number | null {
  const data = dataRange(xml);
  if (!data) return null;
  const tag = new RegExp(`<${name}(?=[\\s>/])`, 'g');
  const starts = [...xml.slice(data.start, data.end).matchAll(tag)];
  return starts.length === 1 ? data.start + starts[0]!.index : null;
}

/** The text inside the file's single `<data>` element, or null when there isn't exactly one, or it isn't plain. */
function dataRange(xml: string): { start: number; end: number } | null {
  const opens = [...xml.matchAll(/<data(?=[\s>/])[^>]*>/g)];
  const closes = [...xml.matchAll(/<\/data\s*>/g)];
  if (opens.length !== 1 || closes.length !== 1) return null;
  const open = opens[0]!;
  if (open[0].endsWith('/>')) return null;
  const range = { start: open.index + open[0].length, end: closes[0]!.index };
  if (range.end < range.start) return null;
  const inner = xml.slice(range.start, range.end);
  // A text scan can't tell markup from a comment or CDATA, and TOM writes neither.
  return inner.includes('<!--') || inner.includes('<![CDATA[') ? null : range;
}

/** Slicing, not String.replace, so `$&` and friends in a name are written literally. */
function splice(s: string, start: number, end: number, text: string): string {
  return s.slice(0, start) + text + s.slice(end);
}

const ATTR_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ATTR_ESCAPES[c]!);
}

function reparse(xml: string): ParsedTdf | null {
  try {
    return parseTdf(xml);
  } catch (err) {
    if (err instanceof TdfError) return null;
    throw err;
  }
}
