/**
 * The date `days` calendar days after `now`'s date in `timeZone`, as the server sees it (YYYY-MM-DD).
 * Counts whole days from today's league date, so a DST change before the target can't shift it (#155).
 */
export function leagueDay(days: number, timeZone: string, now: Date = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
