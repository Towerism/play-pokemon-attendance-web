/**
 * Shim (kit ADR-0007 step A2): the logger now comes from `@towerism/selfhost-kit`,
 * always with attendance's redactor. Removed once call sites switch.
 */
import { type CreateLoggerOptions, type Logger, createLogger as kitCreateLogger } from '@towerism/selfhost-kit';
import { redactor } from './redact';

export {
  type CreateLoggerOptions,
  type LogDestination,
  type LogFields,
  type LogFormat,
  type LogLevel,
  type Logger,
  silentLogger,
} from '@towerism/selfhost-kit';

export function createLogger(options: CreateLoggerOptions): Logger {
  return kitCreateLogger({ ...options, redactor });
}
