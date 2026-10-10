import { z } from 'zod';

/**
 * Wire schemas for api.play.pokemon.com/services/core.
 *
 * STATUS: provisional. Each `TODO(Sx)` is settled by recorded fixtures; the
 * contract is frozen when `wire.contract.test.ts` passes on real fixtures for
 * every FixtureKind and no TODO remains. Objects are `looseObject` so unknown
 * upstream fields pass through; only fields we read are declared.
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
 * S4 (2026-10-10), partial:
 * - An already-present participant (any role, including the session's own
 *   organizer record) rejects the request with 400 `OpErrorResponse`, code
 *   `op.activity_record.cannot_duplicate_participant`, keyed
 *   `errors.body["<index>.participant.player_id"]`.
 * - A non-numeric player id makes the whole request fail with an HTML 500.
 * TODO(S4): success (2xx) body, and whether one rejected item blocks the rest
 * of the batch. Accept anything until that fixture exists.
 */
export const BulkResponse = z.unknown();

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
  errors: z.record(z.string(), z.record(z.string(), z.array(z.looseObject({ code: z.string() })))).optional(),
});
export type OpErrorResponse = z.infer<typeof OpErrorResponse>;

export const ActivityGroupsPage = Page(ActivityGroup);
export const PlaySessionsPage = Page(PlaySession);
export const AttendancePage = Page(AttendanceRecord);

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
