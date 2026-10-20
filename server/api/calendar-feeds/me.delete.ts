/** Turn off the caller's own calendar feed: its link stops working on the next fetch. */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  useCalendar().turnOff(leagueId, actor, 'user');
  setResponseStatus(event, 204);
  return null;
});
