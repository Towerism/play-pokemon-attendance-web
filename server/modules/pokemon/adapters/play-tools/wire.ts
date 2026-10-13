import { z } from 'zod';
import type { NewTournament, TournamentChanges } from '../../ports/play-tools-gateway';
import { EMPTY_DIVISION_INFO } from './constants';

/**
 * Wire schemas for api.play.pokemon.com/services/core.
 *
 * STATUS: frozen 2026-10-10 (M0). Every schema is pinned to sanitized real
 * responses in `__fixtures__/`, enforced by `wire.contract.test.ts`. Change a
 * schema only together with a new recorded fixture. Objects are `looseObject`
 * so unknown upstream fields pass through; only fields we read are declared.
 */

const Guid = z.string().min(1);
/** Player IDs arrive as strings or numbers depending on endpoint; always normalise to string. */
const WirePlayerId = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String);

/**
 * DRF-style paged list envelope (S3, verified on every list endpoint).
 * `next` is an absolute URL with `page` incremented; `page_size` is honoured.
 */
export function Page<T extends z.ZodType>(item: T) {
  return z
    .looseObject({
      count: z.number().int().nonnegative(),
      next: z.string().nullable(),
      previous: z.string().nullable(),
      results: z.array(item),
    })
    .transform((p) => ({ ...p, items: p.results as z.output<T>[] }));
}

/**
 * Item of `core/users/{sub}/activity_groups/` (S5, verified 2026-10-10).
 * A user has a `personal` group plus one per league; `criteria` holds the
 * caller's permissions on that group.
 */
export const ActivityGroup = z.looseObject({
  guid: Guid,
  display_id: z.string().nullable(),
  group_type: z.string(),
  name: z.string().nullable(),
  display_name: z.string().nullable(),
  owner: z.looseObject({ guid: z.string(), player_id: WirePlayerId.nullable() }).nullable().optional(),
  criteria: z
    .looseObject({
      play_sessions: z
        .looseObject({ view: z.boolean(), view_attendance: z.boolean(), create_attendance: z.boolean(), delete_attendance: z.boolean() })
        .partial()
        .optional(),
    })
    .optional(),
});

/** Status filter values the play-tools UI sends (bundle, 2026-10-10). `scheduled`/`completed` are rejected with 400. */
export const PLAY_SESSION_STATUSES = ['active', 'pending', 'complete'] as const;

/** Server-side date filters (UTC ISO instants), as used by the play-tools league page. */
export const PLAY_SESSION_START_GTE = 'start_date:greater_than_or_equal_to';
export const PLAY_SESSION_START_LTE = 'start_date:less_than_or_equal_to';

/**
 * Item of `activity_groups/{id}/play_sessions/` (S3, verified 2026-10-10).
 * Instants are UTC (`…Z`); map to a session date in the league timezone.
 * There is no title: label from `type` + `products` + local start time.
 * `final_modifiable_datetime` is start + 7 days: attendance edits close then.
 */
export const PlaySession = z.looseObject({
  guid: Guid,
  type: z.string(),
  status: z.enum(PLAY_SESSION_STATUSES),
  start_date: z.iso.datetime(),
  end_date: z.iso.datetime().nullable(),
  final_modifiable_datetime: z.iso.datetime().nullable(),
  products: z.array(z.string()),
});

/**
 * Item of `play_sessions/{id}/records/?player=true` (S3, verified 2026-10-10).
 * `guid` is the record id used by DELETE. Participant names are present, so
 * upstream-only players can be named locally (§6.2 upstream_existing).
 */
export const AttendanceRecord = z
  .looseObject({
    guid: Guid,
    role: z.string().nullable(),
    player: z.boolean(),
    origin: z.string(),
    updated: z.string(),
    participant: z.looseObject({
      guid: z.string(),
      player_id: WirePlayerId,
      display_first_name: z.string().nullable(),
      display_last_name: z.string().nullable(),
    }),
  })
  .transform((r) => ({ ...r, recordId: r.guid }));

/** Request body item for `records/_bulk/`, exactly as the CLI and play-tools send it. */
export const BulkRecordRequestItem = z.strictObject({
  participant: z.strictObject({ player_id: z.string() }),
  role: z.null(),
  player: z.literal(true),
  origin: z.literal('roster'),
  updated: z.literal(''),
});
export type BulkRecordRequestItem = z.infer<typeof BulkRecordRequestItem>;

export function bulkRequestBody(playerIds: readonly string[]): BulkRecordRequestItem[] {
  return playerIds.map((player_id) => ({ participant: { player_id }, role: null, player: true, origin: 'roster', updated: '' }));
}

/**
 * `records/_bulk/` semantics (S4, verified 2026-10-10):
 * - Success: 201 with one `{ guid }` (the new record id) per request item, in
 *   request order.
 * - ALL-OR-NOTHING: if any item is rejected, nothing in the batch is added.
 * - An already-present participant (any role, including the session creator's
 *   own organizer record) → 400 `OpErrorResponse`, code
 *   `op.activity_record.cannot_duplicate_participant`, keyed
 *   `errors.body["<index>.participant.player_id"]`.
 * - A non-numeric player id → HTML 500 for the whole request.
 */
export const BulkResponse = z.array(z.looseObject({ guid: Guid }));

/** Error code for "participant already has a record in this session". */
export const DUPLICATE_PARTICIPANT = 'op.activity_record.cannot_duplicate_participant';

/**
 * OP gateway error envelope. Verified 2026-10-10 from an unauthenticated
 * request (401): `{ code: "op.generic.unauthorized", message, errors: { header:
 * { Authorization: [{ code: "op.value.required", … }] } } }`. Field-level
 * errors are grouped by location (header/query/body?) then by field name.
 */
export const OpErrorResponse = z.looseObject({
  code: z.string(),
  message: z.string().optional(),
  errors: z
    .record(z.string(), z.record(z.string(), z.array(z.looseObject({ code: z.string(), attributes: z.record(z.string(), z.unknown()).optional() }))))
    .optional(),
});
export type OpErrorResponse = z.infer<typeof OpErrorResponse>;

/**
 * Item of `core/activities?type=tournament&role=organizer` (S6, recorded 2026-10-11).
 * `start_date` is local wall-clock time stamped `Z` and is not declared: read
 * `start_date_v2` (true UTC), which is null on older tournaments.
 */
export const ActivityTournament = z.looseObject({
  guid: Guid,
  activity_type: z.string(),
  name: z.string().nullable(),
  display_id: z.string().nullable(),
  product: z.string(),
  start_date_v2: z.iso.datetime().nullable(),
  status: z.string(),
  activity_group: z.looseObject({ guid: Guid }).nullable().optional(),
});
export type ActivityTournament = z.infer<typeof ActivityTournament>;

const OptionalText = z.string().nullable().optional();
const OptionalInstant = z.iso.datetime().nullable().optional();

/**
 * `core/tournament/{t}` (S6, recorded 2026-10-11; S8 part 2, 2026-10-13). `organizer.player_id` holds the fixed
 * `organizer` role. `start_date_actual` is true UTC too. The S8 fields are optional, so S6 reads still parse.
 * `address` was redacted whole by the sanitizer, so its shape is unknown and it is read leniently.
 */
export const TournamentDetails = ActivityTournament.omit({ activity_type: true }).extend({
  start_date_actual: OptionalInstant,
  organizer: z.looseObject({ player_id: WirePlayerId, first_name: OptionalText, last_name: OptionalText }),
  application_state: OptionalText,
  activity_state: OptionalText,
  category: OptionalText,
  series: z.looseObject({ guid: Guid, name: OptionalText }).nullable().optional(),
  address: z.unknown().optional(),
  contact_information: z.looseObject({ email: OptionalText, phone: OptionalText }).nullable().optional(),
  registration_start_date_v2: OptionalInstant,
  registration_end_date_v2: OptionalInstant,
  // Recorded as a string ("35", "FREE"); a number is taken as text.
  on_site_admission: z.union([z.string(), z.number()]).transform(String).nullable().optional(),
  third_party_registration_website: OptionalText,
  details: OptionalText,
  event_website: OptionalText,
});

/** A list play-tools pages under `results` with no count (S8: series, address book); `next` only if it pages. */
function ResultsList<T extends z.ZodType>(item: T) {
  return z
    .looseObject({ results: z.array(item), next: z.string().nullable().optional() })
    .transform((p) => ({ items: p.results as z.output<T>[], next: p.next ?? null }));
}

/** Item of `core/users/{sub}/activity_groups/{ag}/series/` (S8 recording 07). `schedule` is per country, inclusive dates. */
export const SeriesItem = z.looseObject({
  guid: Guid,
  name: OptionalText,
  product: z.string(),
  category_slugs: z.array(z.string()),
  tags: z.array(z.string()).optional(),
  play_template: OptionalText,
  schedule: z.record(z.string(), z.looseObject({ start_date: z.iso.date(), end_date: z.iso.date() })).optional(),
  is_enabled: z.boolean().optional(),
  supported_types: z.array(z.string()).optional(),
});
export const SeriesList = ResultsList(SeriesItem);

/** `core/products?country=XX` (S8 recording 06): product codes, and each product's format slugs. */
export const ProductsResponse = z.looseObject({
  results: z.array(z.string()),
  product_categories: z.record(z.string(), z.array(z.string())),
});

/** Item of `core/v2/users/{userGuid}/address_book` (S8 recording 08). */
export const AddressBookItem = z.looseObject({
  guid: Guid,
  name: OptionalText,
  formatted_address: OptionalText,
  country: OptionalText,
  op_country: OptionalText,
  timezone: OptionalText,
});
export const AddressBookList = ResultsList(AddressBookItem);

/** `POST core/tournament` → 201 `{guid}` and nothing else (S8 recording 16). */
export const CreateTournamentResponse = z.looseObject({ guid: Guid });

/** A TDF error: `{type, message}` as recorded (S8 part 2), or a bare code as the bundle shows (S8 part 1). */
export const TdfError = z.union([z.string(), z.looseObject({ type: z.string(), message: OptionalText })]);
export type TdfError = z.infer<typeof TdfError>;

/** `POST triumph/tdf/` → 200, a preview of the file plus `errors` (S8 recording 37). Only the id and errors are read. */
export const ValidateResponse = z.looseObject({ upload_guid: Guid, errors: z.array(TdfError) });

/** `GET triumph/tournament/{display_id}/uploads/`: a bare list, rejected and unconfirmed validations included (S8). */
export const UploadsList = z.array(
  z.looseObject({ guid: Guid, accepted: z.boolean(), errors: z.array(TdfError), upload_timestamp: z.number() }),
);

/**
 * Error envelope of the tournament and TDF calls (S8): `{code, message, errors}`, with field errors keyed by field
 * directly (`{"activity_division_info": ["This field may not be null."]}`). Read leniently: it only feeds messages.
 */
export const TournamentErrorResponse = z.looseObject({
  code: z.string().optional(),
  message: z.string().optional(),
  errors: z.unknown().optional(),
});

/** An instant as play-tools writes it: UTC, whole seconds (`2026-10-12T05:00:00Z`). */
export function wireInstant(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The optional settings, under their wire names, only when given. */
function settingsFields(s: TournamentChanges): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (s.name !== undefined) body.name = s.name;
  if (s.category !== undefined) body.category = s.category;
  if (s.venueId !== undefined) body.address_id = s.venueId;
  if (s.startsAt !== undefined) body.start_date_v2 = wireInstant(s.startsAt);
  if (s.contact !== undefined) body.contact_information = { email: s.contact.email, phone: s.contact.phone };
  if (s.registration !== undefined) {
    body.registration_start_date_v2 = s.registration && wireInstant(s.registration.startsAt);
    body.registration_end_date_v2 = s.registration && wireInstant(s.registration.endsAt);
  }
  if (s.onSiteAdmission !== undefined) body.on_site_admission = s.onSiteAdmission;
  if (s.thirdPartyRegistrationUrl !== undefined) body.third_party_registration_website = s.thirdPartyRegistrationUrl;
  if (s.details !== undefined) body.details = s.details;
  if (s.eventWebsite !== undefined) body.event_website = s.eventWebsite;
  return body;
}

/** `POST core/tournament` (S8 recording 16): `organizer_id` is the professor's user guid; division info is never null. */
export function createTournamentBody(t: NewTournament, organizerGuid: string): Record<string, unknown> {
  return {
    ...settingsFields(t),
    activity_group_id: t.groupId,
    organizer_id: organizerGuid,
    product: t.product,
    series_guid: t.seriesId,
    activity_division_info: EMPTY_DIVISION_INFO,
  };
}

/** `PATCH core/tournament/{guid}/` with only the changed fields: a partial body changes only them (S8 recordings 19–25). */
export function editTournamentBody(changes: TournamentChanges): Record<string, unknown> {
  return settingsFields(changes);
}

/** `PATCH core/tournament/{guid}/` (S8 recording 30). */
export function cancelTournamentBody() {
  return { application_state: 'cancelled' } as const;
}

/** `POST triumph/tdf/` (S8 recording 37): the file as base64 of its UTF-8 bytes. */
export function validateResultsBody(displayId: string, tdf: string) {
  return { kind: 'tdf', tournament_id: displayId, payload: Buffer.from(tdf, 'utf8').toString('base64') } as const;
}

/** `PUT triumph/{upload_guid}/confirm/` takes the tournament guid (S8 recording 39). */
export function confirmResultsBody(tournamentId: string) {
  return { tournament_id: tournamentId } as const;
}

/**
 * Item of `core/tournaments/{t}/records`, unfiltered (S6): players (`player: true`,
 * `role: null`) and staff (`player: false`), the organizer's own record included.
 * The participant also carries `year_of_birth`, which is never read.
 */
export const TournamentRecord = z.looseObject({
  guid: Guid,
  role: z.string().nullable(),
  player: z.boolean(),
  participant: z.looseObject({
    player_id: WirePlayerId,
    display_first_name: z.string().nullable(),
    display_last_name: z.string().nullable(),
  }),
});

/** Request body for assigning one staffer, exactly as play-tools sends it (S6 fixture 07). */
export function staffAssignBody(playerId: string, role: string) {
  return { role, player: false, participant: { player_id: playerId }, origin: 'manual' } as const;
}

/** `201 {guid}`: the new staff record (S6 fixture 07). A re-added staffer gets a new guid. */
export const StaffAssignResponse = z.looseObject({ guid: Guid });

/** Where an assign refusal is keyed (S6): the plain field, since one call carries one staffer. */
export const STAFF_ERROR_FIELD = 'participant.player_id';

/** Tournament statuses that mean it is not happening (S6 part 1). */
export const DEAD_TOURNAMENT_STATUSES: readonly string[] = ['cancelled', 'deleted', 'invalidated'];

export const ActivityGroupsPage = Page(ActivityGroup);
export const PlaySessionsPage = Page(PlaySession);
export const AttendancePage = Page(AttendanceRecord);
export const ActivitiesPage = Page(ActivityTournament);
export const TournamentRecordsPage = Page(TournamentRecord);

/**
 * Fixture kinds → schema. Fixture files are named `<kind>.<label>.json`
 * and hold `{ status, body }`. Used by the spikes (live validation) and by
 * `wire.contract.test.ts` (frozen contract).
 */
export const FIXTURE_SCHEMAS = {
  'activity-groups-page': ActivityGroupsPage,
  'play-sessions-page': PlaySessionsPage,
  'attendance-page': AttendancePage,
  'bulk-response': BulkResponse,
} as const satisfies Record<string, z.ZodType>;
export type FixtureKind = keyof typeof FIXTURE_SCHEMAS;
