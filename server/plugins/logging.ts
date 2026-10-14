import { requestLogPlugin } from '@towerism/selfhost-kit/nitro';

/**
 * Request ids and the request log (architecture §10), from the kit. Every
 * request gets an id (a well-formed `X-Request-Id`, or a new UUID) that is
 * returned on the response and tagged on every log record the request causes.
 * Each request logs one line when it closes; bodies, query strings and headers
 * never. The kit's `http` and `app` children of this logger are the same
 * loggers as `useLogger('http')` and `useLogger('app')`.
 */
export default defineNitroPlugin((nitroApp) => {
  requestLogPlugin({ logger: useLogger('app') })(nitroApp);
});
