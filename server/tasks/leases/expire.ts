/**
 * Hourly upkeep of tournament leases (ADR-0015 §5), scheduled in nuxt.config.ts: a lease stops working the moment its
 * end passes; this records it as expired and sends the lent professor's notice. Logs counts only.
 */
export default defineTask({
  meta: { name: 'leases:expire', description: 'Record tournament leases past their end as expired and send their notices' },
  run() {
    const expired = useLeases().expire();
    useLogger('leases', { expired }).info(`Recorded ${expired} expired tournament lease(s)`);
    return { result: { expired } };
  },
});
