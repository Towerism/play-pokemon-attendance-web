/**
 * Boot: open SQLite, run migrations, print the setup code when there is no
 * account yet. Shutdown: checkpoint the WAL and close (ADR-0006).
 */
export default defineNitroPlugin((nitroApp) => {
  useDatabase();
  useAccounts();
  nitroApp.hooks.hook('close', () => closeDatabase());
});
