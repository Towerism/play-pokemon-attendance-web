/**
 * The app's logger (architecture §10): pino to stdout, readable by default so
 * the organizer can follow it in Unraid's log viewer, JSON on request
 * (`NUXT_LOG_FORMAT=json`). Every record is redacted before it is formatted.
 *
 * Plain TS: the launcher uses it before Nitro loads, and `server/modules/*`
 * receive a `Logger` as a dependency instead of importing one.
 */
import pino from 'pino';
import { prettyFactory } from 'pino-pretty';
import { redact, scrub } from './redact';
import type { LogFields, Logger } from './types';

export { type LogFields, type Logger, silentLogger } from './types';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type LogFormat = 'pretty' | 'json';

export interface LogDestination {
  write(line: string): unknown;
  isTTY?: boolean;
}

export interface CreateLoggerOptions {
  scope: string;
  /** Raw value; defaults to `NUXT_LOG_LEVEL`. Unknown → `info`, with a warning. */
  level?: string;
  /** Raw value; defaults to `NUXT_LOG_FORMAT`. Unknown → `pretty`, with a warning. */
  format?: string;
  /** Called per record; its fields (the request id) are merged in. */
  context?: () => Record<string, unknown> | undefined;
  destination?: LogDestination;
}

const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];
const FORMATS: readonly LogFormat[] = ['pretty', 'json'];
// Shown in the http line's message, so not repeated after it.
const HTTP_FIELDS = ['method', 'path', 'status', 'durationMs'];

export function createLogger(options: CreateLoggerOptions): Logger {
  const warnings: string[] = [];
  const level = pick(LEVELS, 'info', options.level ?? process.env.NUXT_LOG_LEVEL, 'NUXT_LOG_LEVEL', warnings);
  const format = pick(FORMATS, 'pretty', options.format ?? process.env.NUXT_LOG_FORMAT, 'NUXT_LOG_FORMAT', warnings);
  const destination = options.destination ?? process.stdout;

  const toText = format === 'json' ? (line: string) => line : prettyLine(destination);
  const stream = {
    write(line: string) {
      try {
        destination.write(toText(line));
      } catch {
        // A closed pipe or a slow log driver must never take the app down.
      }
    },
  };
  const root = pino(
    {
      level,
      base: undefined,
      formatters: { level: (_label, number) => ({ level: number }) },
      // Errors arrive already redacted as plain objects.
      serializers: { err: (err: unknown) => err },
    },
    stream,
  );

  const log = wrap(root, { scope: options.scope }, options.context);
  for (const warning of warnings) log.warn(warning);
  return log;
}

function wrap(root: pino.Logger, bindings: Record<string, unknown>, context: CreateLoggerOptions['context']): Logger {
  const target = root.child(redact(bindings) as Record<string, unknown>);
  const emit = (level: 'error' | 'warn' | 'info' | 'debug') => (msg: string, fields?: LogFields) => {
    if (!target.isLevelEnabled(level)) return;
    try {
      const record = redact({ ...contextOf(context), ...fields }) as Record<string, unknown>;
      target[level](record, scrub(msg));
    } catch {
      // Logging never fails the caller.
    }
  };
  return {
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    child: (scope, more) => wrap(root, { ...bindings, ...more, scope }, context),
  };
}

function contextOf(context: CreateLoggerOptions['context']): Record<string, unknown> | undefined {
  try {
    return context?.();
  } catch {
    return undefined;
  }
}

function pick<T extends string>(allowed: readonly T[], fallback: T, raw: string | undefined, name: string, warnings: string[]): T {
  if (raw === undefined || raw === '') return fallback;
  const value = raw.toLowerCase() as T;
  if (allowed.includes(value)) return value;
  warnings.push(`${name} "${raw}" is not one of ${allowed.join(', ')}; using ${fallback}.`);
  return fallback;
}

/**
 * `[YYYY-MM-DD HH:mm:ss.SSS] LEVEL: [scope] msg {fields}`, then the error's
 * stack indented by 4 spaces. Newlines in the message are escaped so a record
 * stays on its own line.
 */
function prettyLine(destination: LogDestination): (line: string) => string {
  const prettify = prettyFactory({
    colorize: destination.isTTY === true && !process.env.NO_COLOR,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
    ignore: 'pid,hostname',
    hideObject: true,
    singleLine: true,
    messageFormat: (record: Record<string, unknown>) => {
      const { msg, scope, err, time: _time, level: _level, ...rest } = record;
      if (scope === 'http') for (const field of HTTP_FIELDS) delete rest[field];
      let text = `[${String(scope)}] ${String(msg ?? '').replace(/\r?\n|\r/g, '\\n')}`;
      if (Object.keys(rest).length > 0) text += ` ${JSON.stringify(rest)}`;
      if (err) text += `\n${indent(stackOf(err))}`;
      return text;
    },
  });
  return (line) => `${prettify(line).trimEnd()}\n`;
}

function stackOf(err: unknown): string {
  const e = err as { stack?: unknown; type?: unknown; message?: unknown };
  return typeof e.stack === 'string' ? e.stack : `${String(e.type ?? 'Error')}: ${String(e.message ?? '')}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line.trimStart()}`)
    .join('\n');
}
