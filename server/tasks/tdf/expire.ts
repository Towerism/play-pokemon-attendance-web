/**
 * Hourly cleanup of abandoned TDF previews (ADR-0012 decision 5), scheduled in nuxt.config.ts: previews
 * never committed within a day go (results previews never confirmed too, #96), then the archived files nothing uses any more. Logs counts only.
 */
export default defineTask({
  meta: { name: 'tdf:expire', description: 'Delete TDF previews never imported within a day, and their archived files' },
  run() {
    // Results previews first (#96), so the archive's run can drop the files only they used.
    const results = useTournamentResults().expirePreviews();
    const result = { ...useTdfImports().expirePreviews(), results };
    useLogger('tdf-archive', result).info(
      `Expired ${result.results} results preview(s), ${result.uploads} TDF preview(s) and ${result.files} archived file(s)`,
    );
    return { result };
  },
});
