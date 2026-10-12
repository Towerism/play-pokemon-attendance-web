import { z } from '../zod';
import { playerId } from './roster';
import { sessionDate } from './sessions';

/** An upstream tournament GUID: refused before it can shape a request path. */
export const tournamentId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Not a tournament id');

/** A role code; whether play-tools offers it is the server's check. */
const role = z.string().trim().min(1, 'Choose a role').max(64);

/** Add a staffer to one of the date's tournaments (ADR-0007). `name` only names a player the app can't name yet. */
export const AddStaffBody = z
  .object({
    tournamentId,
    playerId,
    role,
    name: z
      .string()
      .trim()
      .max(100, 'At most 100 characters')
      .optional()
      .transform((s) => s || undefined),
  })
  .transform(({ name, ...rest }) => (name ? { ...rest, name } : rest));
export type AddStaffBody = z.infer<typeof AddStaffBody>;

export const ChangeStaffRoleBody = z.object({ role });

/** Apply one tournament's staff assignments to play-tools (`POST /sessions/{date}/staff/apply`). */
export const ApplyStaffBody = z.object({ tournamentId });

/** Most tournaments one staff batch takes (#76). */
export const STAFF_BATCH_MAX = 20;

/** Apply several of the date's tournaments' staff, one after another (`POST /sessions/{date}/staff/apply-all`, #76). */
export const ApplyAllStaffBody = z.object({
  tournamentIds: z
    .array(tournamentId)
    .min(1, 'Choose at least one tournament')
    .max(STAFF_BATCH_MAX, `At most ${STAFF_BATCH_MAX} tournaments`)
    .refine((ids) => new Set(ids).size === ids.length, 'Each tournament once'),
});

export const StaffBatchIdParam = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,9}$/, 'Not a staff batch id')
    .transform(Number),
});

export const StaffAssignmentParams = z.object({
  date: sessionDate,
  assignmentId: z
    .string()
    .regex(/^[1-9]\d{0,15}$/, 'Not an assignment id')
    .transform(Number),
});

export const STAFF_LIMIT_MAX = 100;

/** The staff list search (`GET /staff`): `q` and `limit` as for `/players`. */
export const StaffQuery = z
  .object({
    q: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((s) => s || undefined),
    limit: z
      .string()
      .regex(/^\d+$/, 'Use a whole number')
      .transform(Number)
      .pipe(z.number().int().min(1).max(STAFF_LIMIT_MAX))
      .optional(),
  })
  .transform(({ q, limit }) => ({ ...(q ? { q } : {}), ...(limit ? { limit } : {}) }));
export type StaffQuery = z.infer<typeof StaffQuery>;
