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

/** What a token may do (ADR-0013, amended by ADR-0015 §7). Mirrors `INTEGRATION_SCOPES` in the integrations module. */
export const INTEGRATION_SCOPES = ['integrations:read', 'messages:deliver'] as const;

/** Mint an integration token (`POST /api/integrations/tokens`); a token minted without scopes reads the day only. */
export const CreateIntegrationTokenBody = z.object({
  label: z.string().trim().min(1, 'Name the token').max(60, 'At most 60 characters'),
  scopes: z.array(z.enum(INTEGRATION_SCOPES)).min(1, 'Choose at least one').default(['integrations:read']),
});

const wholeNumber = (min: number, max: number, fallback: number) =>
  z
    .string()
    .regex(/^\d{1,3}$/, 'A whole number')
    .transform(Number)
    .pipe(z.number().min(min).max(max))
    .default(fallback);

/** `GET /api/integrations/v1/messages?wait=&limit=`: the Discord channel's long poll (ADR-0015 §7). */
export const MessagesQuery = z.object({ wait: wholeNumber(0, 25, 0), limit: wholeNumber(1, 50, 20) });

/** The long poll's answer. Strict, like `AttendanceDayV1`: no topic, ref or sender ever reaches Genie. */
export const MessagesV1 = z.strictObject({
  messages: z.array(
    z.strictObject({
      id: z.number().int().positive(),
      playerId: z.string().min(1),
      text: z.string().min(1).max(1800),
      link: z.strictObject({ label: z.string().min(1).max(60), url: z.string().min(1) }).nullable(),
      expiresAt: z.iso.datetime(),
    }),
  ),
});
export type MessagesV1 = z.infer<typeof MessagesV1>;

/** `POST /api/integrations/v1/messages/{id}/result`. */
export const MessageResultBody = z.strictObject({
  status: z.enum(['delivered', 'no_discord_user', 'dm_refused', 'failed']),
  reason: z.string().max(200).optional(),
});

/** `{id}` of a message. */
export const MessageIdParam = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,15}$/, 'Not a message id')
    .transform(Number),
});

/** `DELETE /api/integrations/tokens/{id}`. */
export const IntegrationTokenIdParam = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,15}$/, 'Not a token id')
    .transform(Number),
});
