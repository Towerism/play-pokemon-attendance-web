/**
 * Attendance's logging configuration (architecture §10). The logger and the redactor come from
 * `@towerism/selfhost-kit` (ADR-0014); this is the one place that adds attendance's own sensitive keys.
 *
 * The kit's `createLogger` hides only its base keys unless it is given a redactor, so every logger in the
 * app is built here, through `createAppLogger` (ESLint rejects the kit's `createLogger`, `createRedactor`
 * and pino anywhere else). A kit API that builds its own logger when none is passed (`runLauncher`) must be
 * given `createAppLogger(...)`.
 *
 * Plain TS: the launcher uses it before Nitro loads. `server/modules/*` take a `Logger` instead.
 */
import { type CreateLoggerOptions, type Logger, createLogger, createRedactor, secretKeyNames } from '@towerism/selfhost-kit';
import { SECRETS } from '../bootstrap/app-env';

/**
 * Added to the kit's base keys: a TDF's birthdates and body (ADR-0012) and the env names of the three
 * secrets, with and without `NUXT_`.
 */
export const ATTENDANCE_LOG_KEYS: readonly string[] = ['birthdate', 'dateOfBirth', 'dob', 'content', 'payload', ...secretKeyNames(SECRETS)];

/** Exported for the redaction contract test. Build loggers with `createAppLogger`, never from this directly. */
export const redactor = createRedactor({ extraKeys: ATTENDANCE_LOG_KEYS });

/** A kit logger with attendance's redactor, which the caller can't replace. */
export function createAppLogger(options: Omit<CreateLoggerOptions, 'redactor'>): Logger {
  return createLogger({ ...options, redactor });
}
