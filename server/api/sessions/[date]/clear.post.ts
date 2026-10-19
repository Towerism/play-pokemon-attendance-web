import { SessionDateParam } from '#shared/schemas/sessions';
import { ClearSessionBody } from '#shared/schemas/submission';

/**
 * Clear session (danger zone, owner only): deletes every player record in the
 * play session, as one of the owner's connections (`professorPlayerId` when
 * they have several). The owner must type the date. 202, then follow
 * `/api/submissions/{id}/events`.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireOwner(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const { playSessionId, confirmDate, professorPlayerId } = await readValidatedBody(event, ClearSessionBody.parse);
  assertClearConfirmed(date, confirmDate);
  const started = await useSubmissions().clear(leagueId, date, playSessionId, actor, professorPlayerId).catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
