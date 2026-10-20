/** Turn off the league's public calendar feed: the owner only. Its link stops working on the next fetch. */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireOwner(event);
  useCalendar().turnOff(leagueId, actor, 'public');
  setResponseStatus(event, 204);
  return null;
});
