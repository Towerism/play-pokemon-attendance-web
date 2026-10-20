/**
 * Hourly refresh of the calendar feeds' snapshot (ADR-0016 §5), scheduled in nuxt.config.ts: only for a league whose
 * feeds were read, turned on or rotated in the last 48 hours, so a league nobody subscribes to causes no play-tools
 * traffic. A refresh's failures are logged by the calendar module per source; this logs one line per league.
 */
export default defineTask({
  meta: { name: 'calendar:refresh', description: "Refresh the calendar feeds' snapshot of leagues whose feeds are in use" },
  async run() {
    const calendar = useCalendar();
    const leagues = calendar.refreshDue();
    for (const leagueId of leagues) {
      await calendar.refresh(leagueId);
      useLogger('calendar', { leagueId }).info('calendar snapshot refreshed');
    }
    return { result: { leagues: leagues.length } };
  },
});
