import { z } from 'zod';
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
