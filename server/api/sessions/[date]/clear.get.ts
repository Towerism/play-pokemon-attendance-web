import { SessionDateParam } from '#shared/schemas/sessions';
import { ClearPreviewQuery } from '#shared/schemas/submission';

/** What clearing the play session would delete, read fresh from play-tools. Changes nothing. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  await requireUserSession(event);
  const { date } = await getValidatedRouterParams(event, SessionDateParam.parse);
  const { playSessionId } = await getValidatedQuery(event, ClearPreviewQuery.parse);
  return useSubmissions().previewClear(leagueId, date, playSessionId).catch(submissionHttpError);
});
