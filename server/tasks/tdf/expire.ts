/**
 * Hourly cleanup of abandoned TDF previews (ADR-0012 decision 5), scheduled in nuxt.config.ts: previews
 * never committed within a day go, then the archived files nothing uses any more. Logs counts only.
 */
export default defineTask({
  meta: { name: 'tdf:expire', description: 'Delete TDF previews never imported within a day, and their archived files' },
  run() {
    const result = useTdfImports().expirePreviews();
    useLogger('tdf-archive', result).info(`Expired ${result.uploads} TDF preview(s) and ${result.files} archived file(s)`);
    return { result };
  },
});
