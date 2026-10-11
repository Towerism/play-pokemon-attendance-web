import { z } from 'zod';

const count = z.number().int().min(1, 'At least 1').max(52, 'At most 52');

/** When a player shows up as a promotion candidate or a stale regular (architecture §5). */
export const Thresholds = z.object({
  /** A non-regular with at least this many sightings in the last 8 weeks. */
  promoteMinSightings: count,
  /** A regular with no tdf or manual sighting in this many league sessions. */
  staleAfterSessions: count,
});
export type Thresholds = z.infer<typeof Thresholds>;

/** `PUT /settings`: the upstream league (activity group), the curation thresholds, or both. */
export const SettingsBody = z
  .object({
    activityGroupId: z.string().trim().min(1).max(100).optional(),
    thresholds: Thresholds.optional(),
  })
  .refine((b) => b.activityGroupId !== undefined || b.thresholds !== undefined, 'Nothing to change');
export type SettingsBody = z.infer<typeof SettingsBody>;
