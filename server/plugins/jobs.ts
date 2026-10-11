/**
 * Job runner boot (architecture §6.2, crash safety): submissions a previous
 * process left `planned` or `running` become `interrupted`, so the organizer
 * can resume them. Stopping jobs on shutdown is the `database` plugin's job,
 * since it must happen before SQLite closes.
 */
export default defineNitroPlugin(() => {
  const interrupted = useSubmissions().recoverInterrupted();
  if (interrupted > 0) console.warn(`[submission] ${interrupted} submission(s) were interrupted by a restart; resume them from History.`);
});
