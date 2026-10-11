import { createLogger } from '../logging/logger';
import type { Logger } from '../logging/types';

let root: Logger | undefined;

/**
 * A logger for Nitro code (plugins, tasks, `server/utils`, routes). Records
 * logged while a request is handled, or by work it started (a submission
 * job), carry its `reqId`. Modules get theirs injected; they never call this.
 */
export function useLogger(scope: string, bindings?: Record<string, unknown>): Logger {
  root ??= createLogger({ scope: 'app', context: requestContext });
  return root.child(scope, bindings);
}

/** The current request's id, from Nitro's async context (`experimental.asyncContext`). */
function requestContext(): Record<string, unknown> | undefined {
  try {
    const reqId = useEvent().context.reqId;
    return typeof reqId === 'string' ? { reqId } : undefined;
  } catch {
    return undefined; // boot, shutdown, scheduled tasks: no request
  }
}
