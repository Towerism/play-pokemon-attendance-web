// League calendar dates (YYYY-MM-DD) and how the Tournaments page names them (#98). No imports, so the Playwright
// journeys share these exact labels instead of copying them.

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `date` + `days`, as YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** Today in the league's time zone: short notice and sanction-by count from it, never the browser's date. */
export function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** "Thu 31 Dec": a league date, read as a calendar date (no time zone shift). */
export function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Oct 2026", or "Q4 2026" for a calendar quarter. */
export function periodLabel(p: { periodStart: string }, cadence: 'month' | 'quarter'): string {
  const [year, month] = p.periodStart.split('-').map(Number) as [number, number];
  return cadence === 'quarter' ? `Q${Math.floor((month - 1) / 3) + 1} ${year}` : `${MONTHS[month - 1]} ${year}`;
}
