import { scheduleRuleSchema } from '../schedule/rule';
import { z } from '../zod';
import { playerId } from './roster';

/** A calendar date, `YYYY-MM-DD` (no Feb 30), as a plain string: tournament dates aren't session dates. */
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, 'Not a calendar date');
/** `HH:MM`, 24-hour, local to the venue. */
export const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');

const id = z.int().min(1).max(9_999_999_999);
const https = z
  .url({ protocol: /^https$/, error: 'Use an https:// link' })
  .max(500, 'At most 500 characters');

/** Optional text: blank or missing is null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .nullish()
    .transform((s) => s || null);

const timeZone = z
  .string()
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'Not a time zone');

const venue = z.strictObject({
  /** The organizer's address-book entry. */
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Not a venue id'),
  label: z.string().trim().min(1).max(120),
  timeZone,
  country: z.string().regex(/^[A-Z]{2}$/, 'A two-letter country code'),
});

const minutes = z.int().min(0).max(1440);
const registration = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('on_site'), opensBeforeMin: minutes, closesAfterMin: minutes, admission: optionalText(500) }),
  z.strictObject({ kind: z.literal('third_party'), url: https }),
]);

/** Custom, or a premier series found per date by a name match (ADR-0010 decisions 3 and 6). */
const templateType = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('custom') }),
  z.strictObject({ kind: z.literal('premier'), seriesMatch: z.string().trim().min(1, 'Name the series').max(80) }),
]);

const templateFields = {
  /** May hold `{month}`, `{year}` and `{date}`. */
  name: z.string().trim().min(1, 'Name the tournament').max(80, 'At most 80 characters'),
  organizerPlayerId: playerId,
  product: z.enum(['tcg', 'vg', 'pgo']),
  category: z.string().regex(/^[a-z0-9_]{1,40}$/, 'Not a format'),
  type: templateType,
  venue,
  startTime: localTime,
  registration,
  contactEmail: z.email().max(254).nullish().transform((s) => s ?? null),
  contactPhone: optionalText(40),
  details: optionalText(2000),
  eventWebsite: https.nullish().transform((s) => s ?? null),
};

const hasContact = (t: { contactEmail?: string | null; contactPhone?: string | null }) => !(t.contactEmail === null && t.contactPhone === null);
const CONTACT = { message: 'Give a contact email or phone', path: ['contactEmail'] };

/** A tournament template (`POST /tournament-templates`). */
export const TemplateBody = z.strictObject(templateFields).refine(hasContact, CONTACT);
export type TemplateBody = z.infer<typeof TemplateBody>;

/** Any fields of a template; at least one, and never both contacts cleared. */
export const TemplatePatch = z
  .strictObject(templateFields)
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'Change at least one field')
  .refine(hasContact, CONTACT);
export type TemplatePatch = z.infer<typeof TemplatePatch>;

export const TemplateListQuery = z.object({ archived: z.literal('1').optional() });

/** Live form choices as one professor (`GET /tournament-templates/options`). */
export const OptionsQuery = z.object({
  professor: playerId,
  country: z.string().regex(/^[A-Z]{2}$/, 'A two-letter country code').default('US'),
  date: localDate.optional(),
});

const slot = z.strictObject({ templateId: id, dayOffset: z.int().min(0).max(6), startTime: localTime.nullish().transform((s) => s ?? null) });
const scaffoldFields = {
  name: z.string().trim().min(1, 'Name the scaffold').max(80),
  slots: z.array(slot).min(1, 'Add a tournament').max(10, 'At most 10 tournaments'),
};
export const ScaffoldBody = z.strictObject(scaffoldFields);
export type ScaffoldBody = z.infer<typeof ScaffoldBody>;
export const ScaffoldPatch = z
  .strictObject(scaffoldFields)
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'Change the name or the slots');
export type ScaffoldPatch = z.infer<typeof ScaffoldPatch>;

const datesInOrder = (s: { startsOn?: string; endsOn?: string | null }) => !s.startsOn || !s.endsOn || s.endsOn >= s.startsOn;
const ORDER = { message: 'The last date is before the first', path: ['endsOn'] };
const scheduleFields = {
  rule: scheduleRuleSchema,
  startsOn: localDate,
  endsOn: localDate.nullish().transform((s) => s ?? null),
  horizonWeeks: z.int().min(1).max(26).optional(),
  paused: z.boolean().optional(),
};
export const ScheduleBody = z.strictObject({ scaffoldId: id, ...scheduleFields }).refine(datesInOrder, ORDER);
export type ScheduleBody = z.infer<typeof ScheduleBody>;
/** Anything but the scaffold: changing it would re-key every planned row. */
export const SchedulePatch = z
  .strictObject(scheduleFields)
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'Change at least one field')
  .refine(datesInOrder, ORDER);
export type SchedulePatch = z.infer<typeof SchedulePatch>;

export const SchedulePreviewBody = z
  .strictObject({
    rule: scheduleRuleSchema,
    startsOn: localDate,
    endsOn: localDate.nullish().transform((s) => s ?? null),
    scaffoldId: id.optional(),
    count: z.int().min(1).max(26).default(10),
  })
  .refine(datesInOrder, ORDER);
export type SchedulePreviewBody = z.infer<typeof SchedulePreviewBody>;

/** A one-off planned tournament from a template (`POST /planned-tournaments`). */
export const PlannedBody = z.strictObject({ templateId: id, localDate, startTime: localTime.optional() });
export type PlannedBody = z.infer<typeof PlannedBody>;

/** A play-tools series id, or `custom`. */
const seriesId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Not a series id');
export const PlannedPatch = z
  .strictObject({ localDate: localDate.optional(), startTime: localTime.optional(), seriesId: seriesId.nullable().optional(), skipped: z.boolean().optional() })
  .refine((p) => Object.keys(p).length > 0, 'Change at least one field');
export type PlannedPatch = z.infer<typeof PlannedPatch>;

/** **Create in play-tools** (`POST /tournaments/create`, #92): 1–60 distinct planned tournaments. */
export const CreateTournamentsBody = z.strictObject({
  plannedIds: z
    .array(id)
    .min(1, 'Choose a tournament')
    .max(60, 'At most 60 at a time')
    .refine((ids) => new Set(ids).size === ids.length, 'Each tournament once'),
  /** Some are less than 7 days ahead (ADR-0010 decision 6). */
  acknowledgeShortNotice: z.boolean().default(false),
  /** Some are `unknown`: an earlier create may still land (#100). */
  retryUnknown: z.boolean().default(false),
});
export type CreateTournamentsBody = z.infer<typeof CreateTournamentsBody>;

/** **Create through date…** (`GET /tournament-schedules/{id}/create-through`). */
export const CreateThroughQuery = z.object({ date: localDate });
export const CreateThroughBody = z.strictObject({ date: localDate, acknowledgeShortNotice: z.boolean().default(false) });
export type CreateThroughBody = z.infer<typeof CreateThroughBody>;

/** What **Edit…** may change (ADR-0010 decision 11): the template form's fields and the date; never the league, organizer, product or type. */
const editChanges = z
  .strictObject({
    name: templateFields.name,
    category: templateFields.category,
    venue,
    localDate,
    startTime: localTime,
    registration,
    contactEmail: templateFields.contactEmail,
    contactPhone: templateFields.contactPhone,
    details: templateFields.details,
    eventWebsite: templateFields.eventWebsite,
  })
  .partial()
  .refine((c) => Object.keys(c).length > 0, 'Change at least one field');

/** The fields a change may carry to the other tournaments of a schedule: never the date. */
const carriedField = z.enum(['name', 'category', 'venue', 'startTime', 'registration', 'contactEmail', 'contactPhone', 'details', 'eventWebsite']);

const editFields = {
  changes: editChanges,
  scope: z.enum(['this', 'later', 'all']).default('this'),
  /** Default: every changed field but the name. */
  fields: z.array(carriedField).max(9).optional(),
  /** The scaffold's other slots on the same dates. */
  withSiblings: z.boolean().default(false),
  updateTemplate: z.boolean().default(false),
};

/** **Edit…** preview (`POST /tournaments/{id}/edit/preview`, #93). */
export const EditBody = z.strictObject(editFields);
export type EditBody = z.infer<typeof EditBody>;

/** A preview entry's key: a planned row, or a play-tools tournament no row holds. */
const editKey = z.string().regex(/^(p:[1-9]\d{0,9}|t:[A-Za-z0-9-]{1,64})$/, 'Not a tournament key');

/** **Edit…** apply (`POST /tournaments/{id}/edit`). */
export const ApplyBody = z.strictObject({
  ...editFields,
  excluded: z.array(editKey).max(200).default([]),
  /** The new date is less than 7 days ahead (ADR-0010 decision 6). */
  acknowledgeShortNotice: z.boolean().default(false),
  /** Remove the overrides that would shadow **Update the template** (#100). */
  clearShadowingOverrides: z.boolean().default(false),
});
export type ApplyBody = z.infer<typeof ApplyBody>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `{id}` of an edit route: a planned tournament id, or a play-tools tournament guid. */
export const EditTargetParam = z.object({
  id: z.union([
    z
      .string()
      .regex(/^[1-9]\d{0,9}$/)
      .transform((s) => ({ kind: 'planned' as const, id: Number(s) })),
    z
      .string()
      .regex(GUID)
      .transform((s) => ({ kind: 'tournament' as const, id: s.toLowerCase() })),
  ]),
});
export type EditTarget = z.infer<typeof EditTargetParam>['id'];

/**
 * `POST /api/tournaments/{id}/cancel` (#94): what the organizer typed to confirm, when anyone is registered. Kept
 * exactly as typed; the server compares it with the display id (or date) from its own fresh read.
 */
export const CancelBody = z.strictObject({ confirmation: z.string().max(32).optional() });
export type CancelBody = z.infer<typeof CancelBody>;

/** At most 366 days, so a year of planned tournaments fits. */
export const MAX_UPCOMING_DAYS = 366;
export const UpcomingQuery = z
  .object({ from: localDate.optional(), to: localDate.optional() })
  .refine((q) => !q.from || !q.to || q.to >= q.from, { message: '`to` is before `from`', path: ['to'] })
  .refine((q) => !q.from || !q.to || (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= MAX_UPCOMING_DAYS - 1, {
    message: `At most ${MAX_UPCOMING_DAYS} days`,
    path: ['to'],
  });

export const IdParam = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,9}$/, 'Not an id')
    .transform(Number),
});
