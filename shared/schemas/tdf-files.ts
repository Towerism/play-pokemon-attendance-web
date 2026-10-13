import { z } from '../zod';
import { sessionDate } from './sessions';

/** The encrypted TDF archive's routes (ADR-0012). */
export const TdfFileIdParam = z.object({
  id: z
    .string()
    .regex(/^[1-9]\d{0,15}$/, 'Not a file id')
    .transform(Number),
});

export const TdfFilesQuery = z.object({
  /** The file's `data/id`. */
  tournamentId: z.string().min(1).max(64).optional(),
  /** The tournament's date in the file. */
  date: sessionDate.optional(),
});
