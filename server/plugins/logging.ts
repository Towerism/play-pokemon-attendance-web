import type { H3Error } from 'h3';
import { acceptRequestId } from '@towerism/selfhost-kit';

const HEALTH = new Set(['/healthz', '/readyz']);

/**
 * Request ids and the request log (architecture §10). Every request gets an
 * id (a well-formed `X-Request-Id`, or a new UUID) that is returned on the
 * response and tagged on every log record the request causes. Each request
 * logs one line when it closes; bodies, query strings and headers never.
 */
export default defineNitroPlugin((nitroApp) => {
  const http = useLogger('http');

  nitroApp.hooks.hook('request', (event) => {
    const reqId = acceptRequestId(event.node.req.headers['x-request-id']);
    event.context.reqId = reqId;
    setResponseHeader(event, 'x-request-id', reqId);

    const started = performance.now();
    const res = event.node.res;
    res.once('close', () => {
      const aborted = !res.writableFinished;
      const status = aborted && !res.headersSent ? 499 : res.statusCode;
      const durationMs = Math.round(performance.now() - started);
      const path = pathOf(event.path);
      // `close` can fire outside the request's async context, so the id is passed explicitly.
      const fields = { method: event.method, path, status, durationMs, reqId, ...(aborted ? { aborted: true } : {}) };
      const message = `${event.method} ${path} ${status} ${durationMs}ms`;
      if (HEALTH.has(path)) http.debug(message, fields);
      else http.info(message, fields);
    });
  });

  nitroApp.hooks.hook('error', (error, { event }) => {
    const statusCode = (error as Partial<H3Error>).statusCode;
    if (!event) {
      useLogger('app').error(`Unhandled error: ${error.message}`, { err: error });
      return;
    }
    const path = pathOf(event.path);
    const fields = { path, reqId: event.context.reqId as string | undefined, ...(statusCode ? { statusCode } : {}) };
    if (statusCode && statusCode < 500) http.warn(`${statusCode} on ${path}: ${error.message}`, fields);
    else http.error(`${statusCode ?? 500} on ${path}: ${error.message}`, { ...fields, err: error });
  });
});

function pathOf(path: string): string {
  return path.split('?')[0] ?? path;
}
