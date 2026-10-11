/**
 * The logger port. `server/modules/*` depend on this (never on pino or on
 * `logger.ts`) and receive a `Logger` from `server/utils`.
 */
export type LogFields = Record<string, unknown> & { err?: unknown };

export interface Logger {
  error(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  child(scope: string, bindings?: Record<string, unknown>): Logger;
}

/** For services built without a logger (unit tests). */
export const silentLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  child: () => silentLogger,
};
