/**
 * Turn on the league's public calendar feed, or rotate its link (ADR-0016 §1): the owner only. 201 when new, 200 when
 * rotated; the link holds the secret, so this answer is the only time it is returned.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireOwner(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  const { secret, feed, created } = await useCalendar().mint(leagueId, actor, 'public');
  setResponseStatus(event, created ? 201 : 200);
  return { kind: 'public' as const, feed, ...calendarLink(event, secret) };
});
