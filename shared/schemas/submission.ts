import { z } from '../zod';
import { sessionDate } from './sessions';

/** `POST /api/sessions/{date}/submissions`: the play session the organizer confirmed after resolving the date. */
export const StartSubmissionBody = z.object({
  playSessionId: z.string().trim().min(1).max(100),
});
export type StartSubmissionBody = z.infer<typeof StartSubmissionBody>;

export const SubmissionIdParam = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,9}$/, 'Not a submission id')
    .transform(Number),
});

/** `GET /api/submissions?date=`: the history, optionally for one date. */
export const SubmissionListQuery = z.object({
  date: sessionDate.optional(),
});

/** `GET /api/sessions/{date}/clear?playSessionId=`: the play session whose clear to preview. */
export const ClearPreviewQuery = z.object({
  playSessionId: z.string().trim().min(1).max(100),
});

/**
 * `POST /api/sessions/{date}/clear`: the play session to clear, and the date
 * the organizer typed to confirm. It is kept exactly as typed; the server
 * compares it with the route's date.
 */
export const ClearSessionBody = z.object({
  playSessionId: z.string().trim().min(1).max(100),
  confirmDate: z.string().max(32),
});
export type ClearSessionBody = z.infer<typeof ClearSessionBody>;
