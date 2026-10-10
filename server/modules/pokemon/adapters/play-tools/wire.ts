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
 * Paged list envelope. The CLI read `data.results || data.data`, so either key
 * may carry the items. TODO(S3): pin the key and the pagination fields
 * (count / next / total_pages?).
 */
export function Page<T extends z.ZodType>(item: T) {
  return z
    .looseObject({
      results: z.array(item).optional(),
      data: z.array(item).optional(),
      count: z.number().int().optional(),
      next: z.string().nullable().optional(),
      previous: z.string().nullable().optional(),
    })
    .refine((p) => p.results !== undefined || p.data !== undefined, {
      message: 'page has neither `results` nor `data`',
    })
    .transform((p) => ({ ...p, items: (p.results ?? p.data)! as z.output<T>[] }));
}

/** TODO(S5): confirm field names (`id` vs `guid`, `name` vs `title`). */
export const ActivityGroup = z.looseObject({
  id: Guid,
  name: z.string().optional(),
});

/**
 * TODO(S3): which field carries the start instant and in which timezone; the
 * candidates below are guesses so the first fixture reveals the real one.
 */
export const PlaySession = z
  .looseObject({
    id: Guid,
    status: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    start_datetime: z.string().optional(),
    start_date: z.string().optional(),
    starts_at: z.string().optional(),
    end_datetime: z.string().optional(),
    end_date: z.string().optional(),
  })
  .refine((s) => s.start_datetime ?? s.start_date ?? s.starts_at, {
    message: 'play session has no recognised start field',
  });

/**
 * The CLI probed `id || record_id || guid || id_record` for the record id.
 * TODO(S3/S4): pin the one field.
 */
export const AttendanceRecord = z
  .looseObject({
    id: Guid.optional(),
    record_id: Guid.optional(),
    guid: Guid.optional(),
    id_record: Guid.optional(),
    participant: z.looseObject({ player_id: WirePlayerId }),
    player: z.boolean().optional(),
    role: z.unknown().optional(),
  })
  .refine((r) => r.id ?? r.record_id ?? r.guid ?? r.id_record, { message: 'record has no id field' })
  .transform((r) => ({ ...r, recordId: (r.id ?? r.record_id ?? r.guid ?? r.id_record)! }));

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
 * TODO(S4): response shape, per-item errors, behaviour for an already-present
 * player. Accept anything until the fixture exists.
 */
export const BulkResponse = z.unknown();

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
