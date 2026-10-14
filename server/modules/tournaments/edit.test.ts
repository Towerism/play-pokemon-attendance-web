import { describe, expect, it } from 'vitest';
import type { TournamentDetails } from '../pokemon/ports/play-tools-gateway';
import {
  type ScopeRow,
  applyValues,
  carriedFields,
  diffValues,
  editDelta,
  formValues,
  pickChanges,
  rescheduleWindow,
  selectScope,
  shadowing,
  siblingFields,
} from './edit';

const ZONE = 'America/Chicago';
const VENUE_ID = '00000000-0000-4000-8000-000000000051';
const OTHER_VENUE = { id: '00000000-0000-4000-8000-000000000052', label: 'Library', timeZone: ZONE, country: 'US' };
/** 2026-10-20 18:00 in Chicago (CDT). */
const START = new Date('2026-10-20T23:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A tournament as a fresh read returns it, with every field the app edits set. */
function read(overrides: Partial<TournamentDetails> = {}): TournamentDetails {
  return {
    id: 'guid-1',
    name: 'Friday Cup October',
    displayId: '26-10-000001',
    groupId: 'group-1',
    products: ['tcg'],
    startsAt: START,
    status: 'sanctioned',
    editableUntil: new Date(START.getTime() + 90 * 24 * HOUR),
    organizerPlayerId: '9999991' as never,
    organizerName: 'Olive Organizer',
    applicationState: 'sanctioned',
    activityState: 'pending',
    category: 'tcg_std',
    series: null,
    venue: { id: VENUE_ID, timeZone: ZONE },
    contact: { email: 'league@example.com', phone: null },
    registration: { startsAt: new Date(START.getTime() - 60 * MIN), endsAt: new Date(START.getTime() + 15 * MIN) },
    onSiteAdmission: '$5',
    thirdPartyRegistrationUrl: null,
    details: 'Bring a deck.',
    eventWebsite: null,
    ...overrides,
  };
}

const delta = (changes: Parameters<typeof editDelta>[1], r = read()) => editDelta(r, changes, { fallbackZone: ZONE });

describe('editDelta: only what differs from the fresh read is sent', () => {
  it.each([
    ['name', { name: 'Friday Cup Halloween' }, { name: 'Friday Cup Halloween' }],
    ['format', { category: 'tcg_exp' }, { category: 'tcg_exp' }],
    ['details', { details: 'Bring two decks.' }, { details: 'Bring two decks.' }],
    ['website', { eventWebsite: 'https://example.com' }, { eventWebsite: 'https://example.com' }],
    ['venue', { venue: OTHER_VENUE }, { venueId: OTHER_VENUE.id }],
  ])('sends a changed %s alone', (_what, changes, expected) => {
    expect(delta(changes).changes).toEqual(expected);
  });

  it('drops a change already at its value', () => {
    expect(delta({ name: 'Friday Cup October', details: 'Bring a deck.', venue: { ...OTHER_VENUE, id: VENUE_ID } }).changes).toEqual({});
  });

  it('moves the start and the registration window with it on a date change', () => {
    const moved = new Date('2026-10-22T23:00:00Z');
    expect(delta({ localDate: '2026-10-22' }).changes).toEqual({
      startsAt: moved,
      registration: { startsAt: new Date(moved.getTime() - 60 * MIN), endsAt: new Date(moved.getTime() + 15 * MIN) },
    });
  });

  it("puts a new start time on the tournament's own date", () => {
    const later = read({ startsAt: new Date('2026-11-03T00:00:00Z'), registration: null }); // 2026-11-02 18:00 CST
    expect(delta({ startTime: '19:00' }, later).changes).toEqual({ startsAt: new Date('2026-11-03T01:00:00Z') });
  });

  it('builds an on-site registration around the new start', () => {
    const d = delta({ startTime: '19:00', registration: { kind: 'on_site', opensBeforeMin: 30, closesAfterMin: 0, admission: '$5' } });
    const start = new Date(START.getTime() + HOUR);
    expect(d.changes).toEqual({ startsAt: start, registration: { startsAt: new Date(start.getTime() - 30 * MIN), endsAt: start } });
  });

  it('switches on-site to third-party: no window, the link', () => {
    expect(delta({ registration: { kind: 'third_party', url: 'https://reg.example.com' } }).changes).toEqual({
      registration: null,
      thirdPartyRegistrationUrl: 'https://reg.example.com',
    });
  });

  it('switches third-party to on-site: the window and admission, the link cleared', () => {
    const r = read({ registration: null, onSiteAdmission: null, thirdPartyRegistrationUrl: 'https://reg.example.com' });
    expect(delta({ registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: 'Free' } }, r).changes).toEqual({
      registration: { startsAt: new Date(START.getTime() - 60 * MIN), endsAt: new Date(START.getTime() + 15 * MIN) },
      onSiteAdmission: 'Free',
      thirdPartyRegistrationUrl: null,
    });
  });

  it('sends both contacts when one changes', () => {
    expect(delta({ contactPhone: '555-0100' }).changes).toEqual({ contact: { email: 'league@example.com', phone: '555-0100' } });
  });

  it('refuses to leave no contact', () => {
    expect(delta({ contactEmail: null }).problem).toBe('contact_required');
  });

  it('keeps the local date and time in a new venue zone, so the start moves', () => {
    const denver = { ...OTHER_VENUE, timeZone: 'America/Denver' };
    const d = delta({ venue: denver });
    expect(d.changes.venueId).toBe(denver.id);
    expect(d.changes.startsAt).toEqual(new Date(START.getTime() + HOUR));
  });

  it('refuses a start a DST change skips', () => {
    const r = read({ startsAt: new Date('2027-03-13T08:30:00Z'), registration: null }); // 2027-03-13 02:30 CST
    expect(delta({ localDate: '2027-03-14' }, r).problem).toBe('start_time_invalid');
  });

  it("falls back to the given zone when the read names no venue zone", () => {
    expect(delta({ startTime: '19:00' }, read({ venue: null, registration: null })).changes).toEqual({ startsAt: new Date(START.getTime() + HOUR) });
  });

  it('is empty on a re-read where the change landed: a landed edit is recognised', () => {
    const changes = { localDate: '2026-10-22', details: 'New.' };
    const sent = delta(changes).changes;
    const landed = read({ startsAt: sent.startsAt!, registration: sent.registration!, details: 'New.' });
    expect(delta(changes, landed).changes).toEqual({});
  });
});

describe('rescheduleWindow: from 3 days before the current date to 90 after (ADR-0010 decision 8)', () => {
  it.each([
    ['2026-10-16', false],
    ['2026-10-17', true],
    ['2026-10-20', true],
    ['2027-01-18', true],
    ['2027-01-19', false],
  ])('today %s → open %s', (today, open) => {
    expect(rescheduleWindow('2026-10-20', today)).toEqual({ opensOn: '2026-10-17', closesOn: '2027-01-18', open });
  });
});

describe('carriedFields: what goes to the other tournaments (ADR-0010 decision 11)', () => {
  const changes = { name: 'N', localDate: '2026-10-22', startTime: '19:00', venue: OTHER_VENUE, details: 'D' };

  it('carries every changed field but the name, and never the date', () => {
    expect(carriedFields(changes)).toEqual(['venue', 'startTime', 'details']);
  });

  it('takes the ticks given, only among the changed fields', () => {
    expect(carriedFields(changes, ['name', 'eventWebsite', 'venue'])).toEqual(['name', 'venue']);
  });

  it('gives siblings only what makes sense across slots', () => {
    expect(siblingFields(['name', 'category', 'venue', 'startTime', 'registration', 'contactEmail', 'contactPhone', 'details', 'eventWebsite'])).toEqual([
      'venue',
      'registration',
      'contactEmail',
      'contactPhone',
      'details',
      'eventWebsite',
    ]);
  });

  it('picks those fields from the changes', () => {
    expect(pickChanges(changes, ['venue', 'details'])).toEqual({ venue: OTHER_VENUE, details: 'D' });
  });
});

describe('selectScope: which rows of the schedule an edit reaches (ADR-0010 decision 11)', () => {
  let nextId = 1;
  const row = (occurrenceDate: string, slotPosition = 0, overrides: Partial<ScopeRow> = {}): ScopeRow => ({
    id: nextId++,
    slotPosition,
    occurrenceDate,
    localDate: occurrenceDate,
    state: 'created',
    ...overrides,
  });
  const weeks = ['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03'];
  const slot0 = weeks.map((d) => row(d));
  const slot1 = weeks.map((d) => row(d, 1));
  const rows = [...slot0, ...slot1];
  const target = slot0[2]!;
  const windowStart = '2026-10-11';
  const ids = (r: { row: ScopeRow }[]) => r.map((x) => x.row.id);

  it('this: nothing else', () => {
    expect(selectScope(rows, target, { scope: 'this', withSiblings: false, windowStart })).toEqual({ inScope: [], leftOut: [] });
  });

  it('later: the same slot on later dates, in date order', () => {
    expect(ids(selectScope(rows, target, { scope: 'later', withSiblings: false, windowStart }).inScope)).toEqual([slot0[3]!.id, slot0[4]!.id]);
  });

  it('all: from the window start on; earlier rows are left out as before_window', () => {
    const picked = selectScope(rows, target, { scope: 'all', withSiblings: false, windowStart });
    expect(ids(picked.inScope)).toEqual([slot0[1]!.id, slot0[3]!.id, slot0[4]!.id]);
    expect(picked.leftOut).toEqual([{ row: slot0[0], sibling: false, reason: 'before_window' }]);
  });

  it('siblings: the other slots on the same dates, its own date included', () => {
    const picked = selectScope(rows, target, { scope: 'later', withSiblings: true, windowStart });
    expect(picked.inScope.map((x) => [x.row.id, x.sibling])).toEqual([
      [slot1[2]!.id, true],
      [slot0[3]!.id, false],
      [slot1[3]!.id, true],
      [slot0[4]!.id, false],
      [slot1[4]!.id, true],
    ]);
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['creating', 'creating'],
    ['unknown', 'unknown'],
  ] as const)('leaves a %s row out', (state, reason) => {
    const odd = row('2026-11-10', 0, { state });
    expect(selectScope([...rows, odd], target, { scope: 'later', withSiblings: false, windowStart }).leftOut).toEqual([{ row: odd, sibling: false, reason }]);
  });

  it('keeps planned, failed and skipped rows in scope: they are updated locally', () => {
    const local = (['planned', 'failed', 'skipped'] as const).map((state, i) => row(`2026-11-1${i}`, 0, { state }));
    expect(ids(selectScope([...rows, ...local], target, { scope: 'later', withSiblings: false, windowStart }).inScope)).toEqual([
      slot0[3]!.id,
      slot0[4]!.id,
      ...local.map((r) => r.id),
    ]);
  });
});

describe('formValues: a fresh read as the edit form shows it', () => {
  const fallback = { timeZone: ZONE, country: 'US', venueLabel: 'Card Shop' };

  it('maps every field, the registration as minutes around the start', () => {
    expect(formValues(read(), fallback)).toEqual({
      name: 'Friday Cup October',
      category: 'tcg_std',
      venue: { id: VENUE_ID, label: 'Card Shop', timeZone: ZONE, country: 'US' },
      localDate: '2026-10-20',
      startTime: '18:00',
      registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: '$5' },
      contactEmail: 'league@example.com',
      contactPhone: null,
      details: 'Bring a deck.',
      eventWebsite: null,
    });
  });

  it('shows a third-party registration as its link, and none as null', () => {
    expect(formValues(read({ registration: null, thirdPartyRegistrationUrl: 'https://r.example.com' }), fallback).registration).toEqual({
      kind: 'third_party',
      url: 'https://r.example.com',
    });
    expect(formValues(read({ registration: null }), fallback).registration).toBeNull();
  });

  it('uses the fallback zone when the read names no venue', () => {
    expect(formValues(read({ venue: null }), { ...fallback, timeZone: 'America/Denver' })).toMatchObject({
      venue: { id: null, timeZone: 'America/Denver' },
      startTime: '17:00',
    });
  });
});

describe('applyValues and diffValues: the preview’s before → after', () => {
  const before = formValues(read(), { timeZone: ZONE, country: 'US', venueLabel: 'Card Shop' });

  it('lists only the fields that change, in form order', () => {
    const after = applyValues(before, { details: 'New.', name: 'Friday Cup October', venue: OTHER_VENUE });
    expect(diffValues(before, after)).toEqual([
      { field: 'venue', before: before.venue, after: OTHER_VENUE },
      { field: 'details', before: 'Bring a deck.', after: 'New.' },
    ]);
  });

  it('is empty when nothing differs', () => {
    expect(diffValues(before, applyValues(before, { contactPhone: null }))).toEqual([]);
  });
});

describe('shadowing: overrides that would still win over a template update (#100)', () => {
  it('names schedule overrides and groups row overrides by schedule, for the carried fields only', () => {
    const shadows = shadowing({
      fields: ['details', 'venue'],
      scheduleOverrides: [
        { id: 7, scheduleId: 3, slotPosition: 0, effectiveFrom: '2026-11-01', fields: { details: 'Sched', name: 'x' } },
        { id: 8, scheduleId: 3, slotPosition: 1, effectiveFrom: '2026-11-01', fields: { name: 'only a name' } },
      ],
      rows: [
        { id: 20, scheduleId: 4, localDate: '2026-12-01', overrides: { venue: OTHER_VENUE } },
        { id: 21, scheduleId: 4, localDate: '2026-10-27', overrides: { details: 'Row', localDate: '2026-10-27' } },
        { id: 22, scheduleId: null, localDate: '2026-10-30', overrides: { startTime: '19:00' } },
      ],
    });
    expect(shadows).toEqual([
      { source: 'schedule', scheduleId: 3, slotPosition: 0, from: '2026-11-01', to: null, fields: ['details'], overrideId: 7 },
      { source: 'rows', scheduleId: 4, slotPosition: null, from: '2026-10-27', to: '2026-12-01', fields: ['venue', 'details'], plannedIds: [21, 20] },
    ]);
  });
});
