/**
 * Settings → Calendar (ADR-0016 §6): the caller's own feed and, for the owner, the public feed, each by its hint only;
 * the snapshot's age and stale sources; where a new link would work; and the league's time zone, which dates are in.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  return { ...useCalendar().feeds(leagueId, actor), reach: calendarReach(), timeZone: leagueTimeZone() };
});
