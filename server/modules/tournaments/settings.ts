import { parseAdmission } from '../../../shared/money/admission';
import { parseLocalDate } from '../../../shared/time/local-time';
import type { LocalDate } from './dates';

/** An address-book entry of the organizer, as the template keeps it (ADR-0010 decision 3). */
export interface TemplateVenue {
  id: string;
  label: string;
  /** IANA zone: the start time is local to it. */
  timeZone: string;
  /** Two-letter country: series windows and formats are per country. */
  country: string;
}

export type RegistrationSettings =
  | { kind: 'on_site'; opensBeforeMin: number; closesAfterMin: number; admissionCents: number | null }
  | { kind: 'third_party'; url: string };

/** The settings a template holds that a schedule or a row may override (ADR-0010 decision 11). */
export interface TemplateSettings {
  /** May hold `{month}`, `{year}` and `{date}` tokens. */
  name: string;
  category: string;
  venue: TemplateVenue;
  /** `HH:MM`, local to the venue. */
  startTime: string;
  registration: RegistrationSettings;
  contactEmail: string | null;
  contactPhone: string | null;
  details: string | null;
  eventWebsite: string | null;
}

export type SettingsOverrides = Partial<TemplateSettings>;

export interface ScheduleOverride {
  /** Applies to the schedule's scaffold dates from this one on. */
  effectiveFrom: LocalDate;
  fields: SettingsOverrides;
}

/** As stored before #194, when admission was text. */
type StoredRegistration = RegistrationSettings | { kind: 'on_site'; opensBeforeMin: number; closesAfterMin: number; admission: string | null };

/**
 * A registration as the database holds it, in the current shape. Admission stored as text before #194 is read as
 * an amount; text that isn't one becomes no admission and comes back as `legacyAdmission`, for the template form
 * to show until the template is saved. Every read of a template's registration or of overrides goes through here
 * or `readOverrides`, so nothing else meets the old shape.
 */
export function readRegistration(stored: unknown): { registration: RegistrationSettings; legacyAdmission: string | null } {
  const r = stored as StoredRegistration;
  if (r.kind !== 'on_site' || !('admission' in r)) return { registration: r, legacyAdmission: null };
  const { admission, ...window } = r;
  const admissionCents = parseAdmission(admission);
  return { registration: { ...window, admissionCents }, legacyAdmission: admissionCents === null ? admission : null };
}

/** A row's or a schedule override's fields as the database holds them, any registration read as `readRegistration` does. */
export function readOverrides(stored: unknown): SettingsOverrides {
  const o = stored as SettingsOverrides;
  return o.registration === undefined ? o : { ...o, registration: readRegistration(o.registration).registration };
}

const FIELDS: readonly (keyof TemplateSettings)[] = [
  'name',
  'category',
  'venue',
  'startTime',
  'registration',
  'contactEmail',
  'contactPhone',
  'details',
  'eventWebsite',
];

/**
 * A planned tournament's settings when it is created: the template's, then each of its slot's schedule
 * overrides in effect on its scaffold date (oldest first), then its own. Only settings fields are taken, so a
 * date never comes from an override. The name's tokens are filled from the tournament's local date.
 */
export function resolveSettings(
  template: TemplateSettings,
  scheduleOverrides: readonly ScheduleOverride[],
  rowOverrides: SettingsOverrides,
  dates: { occurrenceDate: LocalDate; localDate: LocalDate },
): TemplateSettings {
  const layers = [
    ...scheduleOverrides
      .filter((o) => o.effectiveFrom <= dates.occurrenceDate)
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .map((o) => o.fields),
    rowOverrides,
  ];
  const settings = { ...template };
  for (const layer of layers) {
    for (const field of FIELDS) {
      if (layer[field] !== undefined) (settings as Record<string, unknown>)[field] = layer[field];
    }
  }
  return { ...settings, name: fillNameTokens(settings.name, dates.localDate) };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `{month}` → `October`, `{year}` → `2026`, `{date}` → `2026-10-20`; any other braces stay as typed. */
export function fillNameTokens(name: string, date: LocalDate): string {
  const [y, m] = parseLocalDate(date);
  const values: Record<string, string> = { month: MONTHS[m - 1]!, year: String(y), date };
  return name.replace(/\{(month|year|date)\}/g, (_, token: string) => values[token]!);
}
