/**
 * The signals Nitro's graceful shutdown listens for (`nitropack/dist/runtime/internal/shutdown.mjs`), which the Discord
 * channel drains on (ADR-0015 §7). None when that shutdown is disabled: a signal listener stops Node's default exit, and
 * without Nitro's own handler the process would then ignore the signal.
 */
export function shutdownSignals(env: Record<string, string | undefined>): string[] {
  if (env.NITRO_SHUTDOWN_DISABLED) return [];
  return (env.NITRO_SHUTDOWN_SIGNALS || 'SIGTERM SIGINT').split(' ').filter(Boolean);
}
