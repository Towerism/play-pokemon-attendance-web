/**
 * Attendance's logging configuration (architecture §10). The logger and the redactor come from
 * `@towerism/selfhost-kit` (ADR-0014); this is the one place that adds attendance's own sensitive keys.
 *
 * The kit's `createLogger` requires a redactor, and one from `createRedactor()` without attendance's keys
 * hides only the kit's base keys, so every logger in the app is built here, through `createAppLogger`
 * (ESLint rejects the kit's `createLogger`, `createRedactor` and pino anywhere else). A kit API that takes
 * a logger (`runLauncher`) must be given `createAppLogger(...)`.
 *
 * Plain TS: the launcher uses it before Nitro loads. `server/modules/*` take a `Logger` instead.
 */
import { type CreateLoggerOptions, type Logger, createLogger, createRedactor, secretKeyNames } from '@towerism/selfhost-kit';
import { SECRETS } from '../bootstrap/app-env';

/**
 * Added to the kit's base keys: a TDF's birthdates and body (ADR-0012), an invite's link and secret (ADR-0015 §6), and
 * the env names of the four secrets, with and without `NUXT_`.
 */
export const ATTENDANCE_LOG_KEYS: readonly string[] = [
  'birthdate',
  'dateOfBirth',
  'dob',
  'content',
  'payload',
  'inviteUrl',
  'inviteSecret',
  'link',
  ...secretKeyNames(SECRETS),
];

/** Exported for the redaction contract test. Build loggers with `createAppLogger`, never from this directly. */
export const redactor = createRedactor({ extraKeys: ATTENDANCE_LOG_KEYS });

/** A kit logger with attendance's redactor, which the caller can't replace. */
export function createAppLogger(options: Omit<CreateLoggerOptions, 'redactor'>): Logger {
  return createLogger({ ...options, redactor });
}
