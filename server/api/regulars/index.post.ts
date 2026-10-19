import { PlayerInput } from '#shared/schemas/roster';

/** Make a player a regular: 201 when added, 200 when they already were one. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireMember(event);
  const body = await readValidatedBody(event, PlayerInput.parse);
  const { added, regular } = useRoster().addRegular(leagueId, body);
  setResponseStatus(event, added ? 201 : 200);
  return { regular };
});
