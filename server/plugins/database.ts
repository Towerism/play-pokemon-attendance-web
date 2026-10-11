/**
 * Boot: open SQLite, run migrations, print the setup code when there is no
 * account yet. Shutdown: stop submission jobs between batches (they come back
 * `interrupted`), then checkpoint the WAL and close (ADR-0006).
 */
export default defineNitroPlugin((nitroApp) => {
  useDatabase();
  announceSetupCode();
  nitroApp.hooks.hook('close', async () => {
    await stopSubmissions();
    closeDatabase();
  });
});
