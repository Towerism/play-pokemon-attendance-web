import { describe, expect, it } from 'vitest';
import { type IcalCalendar, type IcalEvent, writeCalendar } from './ical';

const STAMP = new Date('2026-10-20T15:00:00Z');

function event(overrides: Partial<IcalEvent> = {}): IcalEvent {
  return {
    uid: 'tournament-abc@default.play-pokemon-attendance',
    start: new Date('2026-11-07T19:00:00Z'),
    end: new Date('2026-11-07T23:00:00Z'),
    summary: "Ettin's September TCG Challenge",
    description: null,
    location: null,
    url: null,
    status: 'CONFIRMED',
    lastModified: new Date('2026-10-19T08:30:05Z'),
    ...overrides,
  };
}

function calendar(events: IcalEvent[], overrides: Partial<IcalCalendar> = {}): IcalCalendar {
  return { name: 'Cerulean League', timeZone: 'America/Chicago', stamp: STAMP, events, ...overrides };
}

/** Undoes RFC 5545 folding: a CRLF followed by one space or tab joins the lines. */
const unfold = (body: string) => body.replace(/\r\n[ \t]/g, '');
const lines = (body: string) => unfold(body).split('\r\n').filter((l) => l !== '');
const property = (body: string, name: string) => lines(body).filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));

describe('writeCalendar', () => {
  it('writes the calendar header with the name, time zone and hourly refresh hints, and ends with CRLF', () => {
    const body = writeCalendar(calendar([]));

    expect(lines(body)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//play-pokemon-attendance//Calendar feeds//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Cerulean League',
      'X-WR-TIMEZONE:America/Chicago',
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
      'X-PUBLISHED-TTL:PT1H',
      'END:VCALENDAR',
    ]);
    expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(body.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('writes one VEVENT with UTC times, the stamp, LAST-MODIFIED and status, and never SEQUENCE or VTIMEZONE', () => {
    const body = writeCalendar(calendar([event({ location: 'Cerulean Gym', url: 'https://example.test/t1', description: 'TCG' })]));

    const all = lines(body);
    const start = all.indexOf('BEGIN:VEVENT');
    expect(all.slice(start, all.indexOf('END:VEVENT') + 1)).toEqual([
      'BEGIN:VEVENT',
      'UID:tournament-abc@default.play-pokemon-attendance',
      'DTSTAMP:20261020T150000Z',
      'LAST-MODIFIED:20261019T083005Z',
      'DTSTART:20261107T190000Z',
      'DTEND:20261107T230000Z',
      "SUMMARY:Ettin's September TCG Challenge",
      'DESCRIPTION:TCG',
      'LOCATION:Cerulean Gym',
      'URL:https://example.test/t1',
      'STATUS:CONFIRMED',
      'END:VEVENT',
    ]);
    expect(body).not.toContain('SEQUENCE');
    expect(body).not.toContain('VTIMEZONE');
  });

  it('leaves out the optional properties that have no value', () => {
    const body = writeCalendar(calendar([event()]));

    expect(property(body, 'DESCRIPTION')).toEqual([]);
    expect(property(body, 'LOCATION')).toEqual([]);
    expect(property(body, 'URL')).toEqual([]);
  });

  it('escapes backslashes, semicolons, commas and newlines in text values', () => {
    const body = writeCalendar(calendar([event({ summary: 'A\\B; C, D\nE\r\nF', location: 'Gym; Room 2, Floor 1' })], { name: 'X, Y' }));

    expect(property(body, 'SUMMARY')).toEqual(['SUMMARY:A\\\\B\\; C\\, D\\nE\\nF']);
    expect(property(body, 'LOCATION')).toEqual(['LOCATION:Gym\\; Room 2\\, Floor 1']);
    expect(property(body, 'X-WR-CALNAME')).toEqual(['X-WR-CALNAME:X\\, Y']);
  });

  it('folds long lines at 75 octets without splitting a multi-byte character, and unfolding restores the value', () => {
    const summary = `${'é'.repeat(40)}, ${'Pokémon '.repeat(10)}; done\\`;
    const body = writeCalendar(calendar([event({ summary })]));

    for (const line of body.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
      expect(line).not.toContain('\uFFFD');
    }
    expect(Buffer.from(body, 'utf8').toString('utf8')).toBe(body);
    expect(property(body, 'SUMMARY')).toEqual([`SUMMARY:${summary.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;')}`]);
  });

  it('writes the same bytes for the same input, with events ordered by start and then UID', () => {
    const a = event({ uid: 'b@x', start: new Date('2026-11-07T19:00:00Z') });
    const b = event({ uid: 'a@x', start: new Date('2026-11-07T19:00:00Z') });
    const c = event({ uid: 'c@x', start: new Date('2026-11-01T19:00:00Z') });

    const first = writeCalendar(calendar([a, b, c]));
    const second = writeCalendar(calendar([c, b, a]));

    expect(first).toBe(second);
    expect(property(first, 'UID')).toEqual(['UID:c@x', 'UID:a@x', 'UID:b@x']);
  });

  it('writes TENTATIVE and CANCELLED statuses as given', () => {
    const body = writeCalendar(calendar([event({ uid: 't@x', status: 'TENTATIVE' }), event({ uid: 'c@x', status: 'CANCELLED' })]));

    expect(property(body, 'STATUS').sort()).toEqual(['STATUS:CANCELLED', 'STATUS:TENTATIVE']);
  });

  it('leaves out a URL that is not http or https, or that holds a control character', () => {
    for (const url of ['javascript:alert(1)', 'https://example.test/a\r\nX-INJECTED:1', 'ftp://example.test', 'https://exa mple.test\tz']) {
      const body = writeCalendar(calendar([event({ url })]));
      expect(property(body, 'URL')).toEqual([]);
      expect(body).not.toContain('X-INJECTED');
    }
  });
});
