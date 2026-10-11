import { z } from 'zod';
import { TDF_MAX_BYTES } from '../tdf/parse';
import { sessionDate } from './sessions';

/**
 * A `.tdf` upload: the file's text sent as JSON, so the JSON-only CSRF guard
 * covers it like every other write (architecture §9).
 */
export const TdfUploadBody = z.object({
  filename: z.string().trim().min(1, 'Name the file').max(255, 'At most 255 characters'),
  /** Size is the parser's call (in bytes), behind the body limit below. */
  content: z.string().min(1, 'The file is empty'),
});
export type TdfUploadBody = z.infer<typeof TdfUploadBody>;

/**
 * Most a JSON upload body may be: the file, JSON-escaped (quotes and newlines
 * double in size), plus the filename. Larger bodies are refused unread.
 */
export const TDF_MAX_BODY_BYTES = 2 * TDF_MAX_BYTES + 4096;

export const TdfUploadParams = z.object({
  date: sessionDate,
  uploadId: z
    .string()
    .regex(/^[1-9]\d{0,15}$/, 'Not an upload id')
    .transform(Number),
});
