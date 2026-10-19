/**
 * Hourly upkeep of the Discord channel (ADR-0015 §7), scheduled in nuxt.config.ts: pending messages past their expiry
 * become expired (their senders' handlers run), and messages older than 30 days are deleted, since the text can hold
 * names. Logs counts only.
 */
export default defineTask({
  meta: { name: 'messaging:expire', description: 'Expire undelivered Discord messages and delete those older than 30 days' },
  run() {
    const result = useMessaging().expire();
    useLogger('messaging', result).info(`Expired ${result.expired} undelivered message(s) and deleted ${result.deleted} old one(s)`);
    return { result };
  },
});
