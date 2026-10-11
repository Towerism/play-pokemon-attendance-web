import { randomUUID } from 'node:crypto';

// Short and log-safe: no spaces, newlines or quotes, so an id can't forge a log line.
const VALID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * The request id for an incoming `X-Request-Id` header: the client's (or a
 * reverse proxy's) value when it is well-formed, otherwise a fresh UUID. A
 * rejected value is dropped, never logged.
 */
export function acceptRequestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && VALID.test(header) ? header : randomUUID();
}
