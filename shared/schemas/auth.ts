import { z } from '../zod';

const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'At least 3 characters')
  .max(32, 'At most 32 characters')
  .regex(/^[a-z0-9._-]+$/, 'Letters, digits, dots, dashes and underscores only');

// Upper bound keeps scrypt from hashing megabytes.
const PASSWORD_MAX = 256;

export const SetupBody = z.object({
  setupCode: z.string().trim().min(1, 'Enter the setup code from the container log').max(64),
  username,
  password: z.string().min(8, 'At least 8 characters').max(PASSWORD_MAX),
});
export type SetupBody = z.infer<typeof SetupBody>;

export const LoginBody = z.object({
  // Same normalization as setup, but no format rules: a bad username just fails to log in.
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX),
});
export type LoginBody = z.infer<typeof LoginBody>;
