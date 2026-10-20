/**
 * Turn on the caller's own calendar feed, or rotate its link (ADR-0016 §1): 201 when new, 200 when rotated. The link
 * holds the secret, so this answer is the only time it is returned.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  const { secret, feed, created } = await useCalendar().mint(leagueId, actor, 'user');
  setResponseStatus(event, created ? 201 : 200);
  return { kind: 'user' as const, feed, ...calendarLink(event, secret) };
});
