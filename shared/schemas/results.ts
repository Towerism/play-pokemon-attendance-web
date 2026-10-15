import { z } from '../zod';
import { playerId } from './roster';
import { sessionDate } from './sessions';
import { TdfUploadBody } from './tdf';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/sessions/{date}/tournaments/{tournamentId}/results` (ADR-0011): the card's date and its play-tools tournament guid. */
export const ResultsParams = z.object({
  date: sessionDate,
  tournamentId: z
    .string()
    .regex(GUID, 'Not a tournament id')
    .transform((s) => s.toLowerCase()),
});

/** `…/results/{uploadId}/…`. */
export const ResultsUploadParams = ResultsParams.extend({
  uploadId: z
    .string()
    .regex(/^[1-9]\d{0,15}$/, 'Not an upload id')
    .transform(Number),
});

/** The preview: the file's text as JSON, as the attendance import takes it, and nothing else. */
export const ResultsPreviewBody = TdfUploadBody.strict();
export type ResultsPreviewBody = z.infer<typeof ResultsPreviewBody>;

/**
 * The send (ADR-0011 decision 4, #101): the fingerprint of the warnings the dialog showed, required even when there
 * were none, and whether to import attendance from the same file.
 */
export const ResultsConfirmBody = z.strictObject({
  importAttendance: z.boolean(),
  acknowledgedWarnings: z.string().regex(/^[0-9a-f]{64}$/, 'Not a warnings fingerprint'),
});
export type ResultsConfirmBody = z.infer<typeof ResultsConfirmBody>;

/** **Remove from staff** (ADR-0007 update, #101): the players the TDF lists as playing who are also staff. */
export const ResultsRemoveStaffBody = z.strictObject({
  playerIds: z
    .array(playerId)
    .min(1, 'Name at least one player')
    .max(50, 'At most 50 players')
    .refine((ids) => new Set(ids).size === ids.length, 'Each player once'),
});
export type ResultsRemoveStaffBody = z.infer<typeof ResultsRemoveStaffBody>;

/** The tournament organizer's full name, as it should appear in the TDF (ADR-0011 decision 8): saved on their connection. */
export const ResultsOrganizerBody = z.strictObject({
  fullName: z
    .string()
    .trim()
    .min(1, 'Enter the full name')
    .max(100, 'At most 100 characters')
    .regex(/^[^\p{Cc}]*$/u, 'No control characters'),
});
export type ResultsOrganizerBody = z.infer<typeof ResultsOrganizerBody>;
