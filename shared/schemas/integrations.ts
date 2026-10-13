import { z } from '../zod';

/** The staff roles the v1 contract carries (play-tools' assignable roles; never `organizer`). */
export const INTEGRATION_STAFF_ROLES = ['headjudge', 'judge', 'scorekeeper', 'administration', 'translator'] as const;
export type IntegrationStaffRole = (typeof INTEGRATION_STAFF_ROLES)[number];

/**
 * `GET /api/integrations/v1/days/{date}` (#115, ADR-0013): the contract Tournament Genie imports. Strict, so a
 * field added or renamed fails the tests that parse responses with it; v1 only ever grows additively.
 */
export const AttendanceDayV1 = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
  tournaments: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      displayId: z.string().nullable(),
      startsAt: z.iso.datetime(),
      game: z.enum(['tcg', 'vgc', 'go']).nullable(),
      organizer: z.strictObject({ playerId: z.string().min(1), name: z.string().min(1) }),
      staff: z.array(z.strictObject({ playerId: z.string().min(1), name: z.string(), role: z.enum(INTEGRATION_STAFF_ROLES) })),
    }),
  ),
  professors: z.array(
    z.strictObject({
      playerId: z.string().min(1),
      name: z.string().min(1),
      status: z.enum(['read', 'unread']),
      reason: z.enum(['needs_reconnect', 'read_failed']).optional(),
    }),
  ),
});
export type AttendanceDayV1 = z.infer<typeof AttendanceDayV1>;

/** Mint an integration token (`POST /api/integrations/tokens`). */
export const CreateIntegrationTokenBody = z.object({
  label: z.string().trim().min(1, 'Name the token').max(60, 'At most 60 characters'),
});

/** `DELETE /api/integrations/tokens/{id}`. */
export const IntegrationTokenIdParam = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,15}$/, 'Not a token id')
    .transform(Number),
});
