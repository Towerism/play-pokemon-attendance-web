import { z } from '../zod';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `POST /api/tournament-leases` (ADR-0015 §5): lend 1–20 play-tools tournaments to one league member, all or none. */
export const GrantLeasesBody = z.strictObject({
  tournamentIds: z
    .array(
      z
        .string()
        .regex(GUID, 'Not a tournament id')
        .transform((s) => s.toLowerCase()),
    )
    .min(1, 'Pick at least one tournament')
    .max(20, 'At most 20 tournaments at once')
    .refine((ids) => new Set(ids).size === ids.length, 'Each tournament once'),
  lesseeUserId: z.number().int().positive(),
  /** When the lease ends; the server checks it is ahead and within 30 days of each start. */
  endsAt: z.iso.datetime({ offset: true }).optional(),
});
export type GrantLeasesBody = z.infer<typeof GrantLeasesBody>;

export const LeaseIdParam = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,15}$/, 'Not an id')
    .transform(Number),
});
