import { z } from '../zod';
import { password, username } from './auth';
import { ProfessorPlayerId } from './pokemon';

const send = z.enum(['copy', 'discord']);

/** `POST /api/professors/invites` (ADR-0015 §6): Send by Discord needs a bound player ID to address. */
export const MintInviteBody = z
  .object({
    label: z.string().trim().min(1, 'Leave it empty or give a name').max(60, 'At most 60 characters').optional(),
    playerId: ProfessorPlayerId.optional(),
    send,
  })
  .refine((b) => b.send !== 'discord' || b.playerId !== undefined, { message: 'Pick who to send it to', path: ['playerId'] });
export type MintInviteBody = z.infer<typeof MintInviteBody>;

/** `POST /api/professors/{userId}/reset-link` (ADR-0015 §8). */
export const MintResetBody = z.object({ send });

const positiveId = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, 'Not an id')
  .transform(Number);

export const ProfessorIdParam = z.object({ userId: positiveId });
export const InviteIdParam = z.object({ id: positiveId });

/** The public invite routes take any secret up to 200 characters: a malformed one is refused like any unusable one. */
const secret = z.string().min(1).max(200);

export const InviteCheckBody = z.object({ secret });

/** A username is needed for an invite and ignored for a reset link; the service decides which. */
export const InviteAcceptBody = z.object({ secret, username: username.optional(), password });
