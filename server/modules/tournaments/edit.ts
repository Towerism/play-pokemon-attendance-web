import { LocalTimeError, dateIn, localInstant } from '../../../shared/time/local-time';
import type { Registration, TournamentChanges, TournamentDetails } from '../pokemon/ports/play-tools-gateway';
import { type LocalDate, addDays, timeIn } from './dates';
import type { PlannedRowState } from './plan';
import type { RegistrationSettings, TemplateVenue } from './settings';

/** What the organizer may change on a tournament (ADR-0010 decision 11), in the app's terms. */
export interface EditChanges {
  name?: string;
  category?: string;
  venue?: TemplateVenue;
  localDate?: LocalDate;
  startTime?: string;
  registration?: RegistrationSettings;
  contactEmail?: string | null;
  contactPhone?: string | null;
  details?: string | null;
  eventWebsite?: string | null;
}

/** The fields a change can carry to the other tournaments of a schedule: never the date. */
export type CarriedField = 'name' | 'category' | 'venue' | 'startTime' | 'registration' | 'contactEmail' | 'contactPhone' | 'details' | 'eventWebsite';

const CARRIABLE: readonly CarriedField[] = ['name', 'category', 'venue', 'startTime', 'registration', 'contactEmail', 'contactPhone', 'details', 'eventWebsite'];

/** What makes sense across the scaffold's other slots on the same date (ADR-0010 decision 11). */
const SIBLING_SAFE: ReadonlySet<CarriedField> = new Set(['venue', 'registration', 'contactEmail', 'contactPhone', 'details', 'eventWebsite']);

/**
 * The changed fields that go to the other tournaments: the ticks given, else every changed field but the name
 * (names often carry their month or date). The date never carries over. Pure.
 */
export function carriedFields(changes: EditChanges, ticks?: readonly CarriedField[]): CarriedField[] {
  return CARRIABLE.filter((f) => changes[f] !== undefined && (ticks ? ticks.includes(f) : f !== 'name'));
}

export function siblingFields(fields: readonly CarriedField[]): CarriedField[] {
  return fields.filter((f) => SIBLING_SAFE.has(f));
}

export function pickChanges(changes: EditChanges, fields: readonly CarriedField[]): EditChanges {
  return Object.fromEntries(fields.filter((f) => changes[f] !== undefined).map((f) => [f, changes[f]]));
}

/**
 * When a tournament's date may be changed (ADR-0010 decision 8): from 3 days before its current local date to 90
 * days after, both inclusive, by local dates in the league time zone. Pure.
 */
export function rescheduleWindow(current: LocalDate, today: LocalDate): { opensOn: LocalDate; closesOn: LocalDate; open: boolean } {
  const opensOn = addDays(current, -3);
  const closesOn = addDays(current, 90);
  return { opensOn, closesOn, open: today >= opensOn && today <= closesOn };
}

/** What the edit form shows (ADR-0010 decision 11): the template form's fields, the date and time on the venue's wall clock. */
export interface EditValues {
  name: string;
  category: string | null;
  venue: { id: string | null; label: string | null; timeZone: string; country: string };
  localDate: LocalDate;
  startTime: string;
  registration: RegistrationSettings | null;
  contactEmail: string | null;
  contactPhone: string | null;
  details: string | null;
  eventWebsite: string | null;
}

const VALUE_FIELDS: readonly (keyof EditValues)[] = [
  'name',
  'category',
  'venue',
  'localDate',
  'startTime',
  'registration',
  'contactEmail',
  'contactPhone',
  'details',
  'eventWebsite',
];

/**
 * A fresh read as the form shows it. An on-site registration is its minutes around the start. `fallback` fills what
 * a read may lack: the venue's zone (the template's, else the league's), country and label. Pure.
 */
export function formValues(read: TournamentDetails, fallback: { timeZone: string; country: string; venueLabel: string | null }): EditValues {
  const zone = read.venue?.timeZone ?? fallback.timeZone;
  const start = read.startsAt;
  let registration: RegistrationSettings | null = null;
  if (read.thirdPartyRegistrationUrl) registration = { kind: 'third_party', url: read.thirdPartyRegistrationUrl };
  else if (read.registration && start) {
    registration = {
      kind: 'on_site',
      opensBeforeMin: Math.round((start.getTime() - read.registration.startsAt.getTime()) / MINUTE_MS),
      closesAfterMin: Math.round((read.registration.endsAt.getTime() - start.getTime()) / MINUTE_MS),
      admission: read.onSiteAdmission,
    };
  }
  return {
    name: read.name ?? '',
    category: read.category,
    venue: { id: read.venue?.id ?? null, label: fallback.venueLabel, timeZone: zone, country: fallback.country },
    localDate: start ? dateIn(start, zone) : '',
    startTime: start ? timeIn(start, zone) : '',
    registration,
    contactEmail: read.contact.email,
    contactPhone: read.contact.phone,
    details: read.details,
    eventWebsite: read.eventWebsite,
  };
}

/** The values once the changes apply. */
export function applyValues(values: EditValues, changes: EditChanges): EditValues {
  const out = { ...values } as Record<string, unknown>;
  for (const [field, value] of Object.entries(changes)) if (value !== undefined) out[field] = value;
  return out as unknown as EditValues;
}

/** Each field that differs, in form order: a preview's before → after. */
export function diffValues(before: EditValues, after: EditValues) {
  return VALUE_FIELDS.filter((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f])).map((field) => ({ field, before: before[field], after: after[field] }));
}

/** A planned row of the edited schedule, as scope selection needs it. */
export interface ScopeRow {
  id: number;
  slotPosition: number;
  occurrenceDate: LocalDate;
  localDate: LocalDate;
  state: PlannedRowState;
}

export type EditScope = 'this' | 'later' | 'all';
export type ScopeLeftOut = 'cancelled' | 'creating' | 'unknown' | 'before_window';

const LEFT_OUT_STATES: Partial<Record<PlannedRowState, ScopeLeftOut>> = { cancelled: 'cancelled', creating: 'creating', unknown: 'unknown' };

/**
 * The other rows an edit reaches (ADR-0010 decision 11): for `later` the same slot on later scaffold dates, for `all`
 * every date; with siblings, the scaffold's other slots on those dates and on the edited one's. Rows a create holds
 * or may have made, cancelled ones, and ones before the creatable window are left out with why. In date, then slot
 * order. Pure.
 */
export function selectScope(
  rows: readonly ScopeRow[],
  target: ScopeRow,
  opts: { scope: EditScope; withSiblings: boolean; windowStart: LocalDate },
): { inScope: { row: ScopeRow; sibling: boolean }[]; leftOut: { row: ScopeRow; sibling: boolean; reason: ScopeLeftOut }[] } {
  const dateInScope = (d: LocalDate) => (opts.scope === 'all' ? true : opts.scope === 'later' ? d > target.occurrenceDate : false);
  const picked = rows
    .filter((r) => r.id !== target.id)
    .filter((r) =>
      r.slotPosition === target.slotPosition
        ? dateInScope(r.occurrenceDate)
        : opts.withSiblings && (r.occurrenceDate === target.occurrenceDate || dateInScope(r.occurrenceDate)),
    )
    .sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate) || a.slotPosition - b.slotPosition || a.id - b.id);
  const inScope: { row: ScopeRow; sibling: boolean }[] = [];
  const leftOut: { row: ScopeRow; sibling: boolean; reason: ScopeLeftOut }[] = [];
  for (const row of picked) {
    const sibling = row.slotPosition !== target.slotPosition;
    const reason = LEFT_OUT_STATES[row.state] ?? (row.localDate < opts.windowStart ? 'before_window' : undefined);
    if (reason) leftOut.push({ row, sibling, reason });
    else inScope.push({ row, sibling });
  }
  return { inScope, leftOut };
}

export interface Shadow {
  source: 'schedule' | 'rows';
  scheduleId: number | null;
  slotPosition: number | null;
  from: LocalDate;
  to: LocalDate | null;
  fields: CarriedField[];
  overrideId?: number;
  plannedIds?: number[];
}

/**
 * The overrides that would still win over **Update the template** for the carried fields (#100): each schedule
 * override setting one, and the rows not created yet that set one, grouped by schedule (null for one-offs). The
 * caller passes only those of the template, from the creatable window on. Pure.
 */
export function shadowing(input: {
  fields: readonly CarriedField[];
  scheduleOverrides: readonly { id: number; scheduleId: number; slotPosition: number; effectiveFrom: LocalDate; fields: Record<string, unknown> }[];
  rows: readonly { id: number; scheduleId: number | null; localDate: LocalDate; overrides: Record<string, unknown> }[];
}): Shadow[] {
  const setIn = (o: Record<string, unknown>) => CARRIABLE.filter((f) => input.fields.includes(f) && o[f] !== undefined);
  const shadows: Shadow[] = [];
  for (const o of input.scheduleOverrides) {
    const fields = setIn(o.fields);
    if (fields.length > 0) shadows.push({ source: 'schedule', scheduleId: o.scheduleId, slotPosition: o.slotPosition, from: o.effectiveFrom, to: null, fields, overrideId: o.id });
  }
  const groups = new Map<number | null, { id: number; localDate: LocalDate; fields: CarriedField[] }[]>();
  for (const r of input.rows) {
    const fields = setIn(r.overrides);
    if (fields.length === 0) continue;
    groups.set(r.scheduleId, [...(groups.get(r.scheduleId) ?? []), { id: r.id, localDate: r.localDate, fields }]);
  }
  for (const [scheduleId, members] of groups) {
    members.sort((a, b) => a.localDate.localeCompare(b.localDate) || a.id - b.id);
    const fields = CARRIABLE.filter((f) => members.some((m) => m.fields.includes(f)));
    shadows.push({ source: 'rows', scheduleId, slotPosition: null, from: members[0]!.localDate, to: members.at(-1)!.localDate, fields, plannedIds: members.map((m) => m.id) });
  }
  return shadows;
}

export type DeltaProblem = 'start_time_invalid' | 'contact_required';

export interface Delta {
  /** Only the fields that differ from the read: what a `PATCH` holds (ADR-0010 update #90). */
  changes: TournamentChanges;
  /** The start once the changes apply; null when the read has none and nothing sets one. */
  startsAt: Date | null;
  problem?: DeltaProblem;
}

const MINUTE_MS = 60_000;

const sameTime = (a: Date | null | undefined, b: Date | null | undefined) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
const sameRegistration = (a: Registration | null, b: Registration | null) =>
  a === null || b === null ? a === b : sameTime(a.startsAt, b.startsAt) && sameTime(a.endsAt, b.endsAt);

/**
 * What one tournament's `PATCH` must hold: `changes` applied over a fresh read, keeping only what differs. A new
 * date or start time is on the venue's wall clock (a time alone keeps the read's own date), a new venue keeps the
 * local date and time in its zone, an on-site registration is built around the new start, and an unchanged window
 * moves with the start. Empty when the read already holds every change, so a landed edit is recognised. Pure.
 */
export function editDelta(read: TournamentDetails, changes: EditChanges, opts: { fallbackZone: string }): Delta {
  const out: TournamentChanges & Record<string, unknown> = {};
  const zone = read.venue?.timeZone ?? opts.fallbackZone;
  const newZone = changes.venue?.timeZone ?? zone;

  if (changes.name !== undefined && changes.name !== read.name) out.name = changes.name;
  if (changes.category !== undefined && changes.category !== read.category) out.category = changes.category;
  if (changes.venue !== undefined && changes.venue.id !== read.venue?.id) out.venueId = changes.venue.id;
  if (changes.details !== undefined && changes.details !== read.details) out.details = changes.details;
  if (changes.eventWebsite !== undefined && changes.eventWebsite !== read.eventWebsite) out.eventWebsite = changes.eventWebsite;

  let startsAt = read.startsAt;
  const movesStart = changes.localDate !== undefined || changes.startTime !== undefined || newZone !== zone;
  if (movesStart && (read.startsAt !== null || (changes.localDate !== undefined && changes.startTime !== undefined))) {
    const date = changes.localDate ?? dateIn(read.startsAt!, zone);
    const time = changes.startTime ?? timeIn(read.startsAt!, zone);
    try {
      startsAt = localInstant(date, time, newZone);
    } catch (err) {
      if (!(err instanceof LocalTimeError)) throw err;
      return { changes: {}, startsAt: null, problem: 'start_time_invalid' };
    }
    if (!sameTime(startsAt, read.startsAt)) out.startsAt = startsAt;
  }

  const reg = changes.registration;
  if (reg?.kind === 'on_site' && startsAt) {
    const window = { startsAt: new Date(startsAt.getTime() - reg.opensBeforeMin * MINUTE_MS), endsAt: new Date(startsAt.getTime() + reg.closesAfterMin * MINUTE_MS) };
    if (!sameRegistration(window, read.registration)) out.registration = window;
    if (reg.admission !== read.onSiteAdmission) out.onSiteAdmission = reg.admission;
    if (read.thirdPartyRegistrationUrl !== null) out.thirdPartyRegistrationUrl = null;
  } else if (reg?.kind === 'third_party') {
    if (read.registration !== null) out.registration = null;
    if (reg.url !== read.thirdPartyRegistrationUrl) out.thirdPartyRegistrationUrl = reg.url;
  } else if (out.startsAt && read.registration && read.startsAt) {
    // The window keeps its offsets from the start (ADR-0010 decision 8).
    const by = out.startsAt.getTime() - read.startsAt.getTime();
    out.registration = { startsAt: new Date(read.registration.startsAt.getTime() + by), endsAt: new Date(read.registration.endsAt.getTime() + by) };
  }

  if (changes.contactEmail !== undefined || changes.contactPhone !== undefined) {
    const contact = {
      email: changes.contactEmail !== undefined ? changes.contactEmail : read.contact.email,
      phone: changes.contactPhone !== undefined ? changes.contactPhone : read.contact.phone,
    };
    if (contact.email === null && contact.phone === null) return { changes: {}, startsAt, problem: 'contact_required' };
    if (contact.email !== read.contact.email || contact.phone !== read.contact.phone) out.contact = contact;
  }
  return { changes: out, startsAt };
}
