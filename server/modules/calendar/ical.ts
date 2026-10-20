/**
 * A small iCalendar (RFC 5545) writer for the subscribed feeds (ADR-0016 §8). It writes only what the feeds need:
 * one `VCALENDAR` with `METHOD:PUBLISH` and one `VEVENT` per event, times in UTC so no `VTIMEZONE` is needed, and no
 * `SEQUENCE` (that belongs to invitations). Pure and dependency-free; the same input always gives the same bytes.
 */

export type IcalStatus = 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';

export interface IcalEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description: string | null;
  location: string | null;
  url: string | null;
  status: IcalStatus;
  lastModified: Date;
}

export interface IcalCalendar {
  /** `X-WR-CALNAME`, the name calendar apps show for the subscription. */
  name: string;
  /** `X-WR-TIMEZONE`, the league's IANA zone; a hint only, since every time is UTC. */
  timeZone: string;
  /** `DTSTAMP` of every event: when the snapshot was built. */
  stamp: Date;
  events: readonly IcalEvent[];
}

const PRODID = '-//play-pokemon-attendance//Calendar feeds//EN';
/** RFC 5545 §3.1: a content line is at most 75 octets, excluding the CRLF. */
const MAX_OCTETS = 75;

export function writeCalendar(calendar: IcalCalendar): string {
  const out: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${text(calendar.name)}`,
    `X-WR-TIMEZONE:${text(calendar.timeZone)}`,
    // Clients that honour these poll hourly, matching the snapshot's refresh.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of [...calendar.events].sort(byStartThenUid)) out.push(...vevent(e, calendar.stamp));
  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n') + '\r\n';
}

function vevent(e: IcalEvent, stamp: Date): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${text(e.uid)}`,
    `DTSTAMP:${utc(stamp)}`,
    `LAST-MODIFIED:${utc(e.lastModified)}`,
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(e.end)}`,
    `SUMMARY:${text(e.summary)}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${text(e.description)}`);
  if (e.location) lines.push(`LOCATION:${text(e.location)}`);
  const url = safeUri(e.url);
  if (url) lines.push(`URL:${url}`);
  lines.push(`STATUS:${e.status}`, 'END:VEVENT');
  return lines;
}

function byStartThenUid(a: IcalEvent, b: IcalEvent): number {
  return a.start.getTime() - b.start.getTime() || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
}

/** `YYYYMMDDTHHMMSSZ`. */
function utc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * TEXT escaping (RFC 5545 §3.3.11); a CRLF, CR or LF becomes one `\n`, and any other control character but tab is
 * dropped, since TEXT may not hold one.
 */
function text(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  return [...escaped].filter((ch) => ch === '\t' || !isControl(ch)).join('');
}

/**
 * A URI value isn't TEXT, so it can't be escaped: anything but a plain http(s) URL with no control character or
 * space is left out, so a stored value can never add a line to the feed. Exported for URLs written into a description.
 */
export function safeUri(value: string | null): string | null {
  if (!value || !/^https?:\/\//i.test(value) || [...value].some(isControlOrSpace)) return null;
  return value;
}

function isControlOrSpace(ch: string): boolean {
  return ch === ' ' || isControl(ch);
}

function isControl(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return code < 0x20 || code === 0x7f;
}

/** Folds a content line at 75 octets, never inside a UTF-8 character; continuation lines start with one space. */
function fold(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_OCTETS) return line;
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  // A continuation line's leading space counts toward its 75 octets.
  let limit = MAX_OCTETS;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
      limit = MAX_OCTETS - 1;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}
