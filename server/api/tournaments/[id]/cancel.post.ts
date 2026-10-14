import { CancelBody, EditTargetParam } from '#shared/schemas/tournaments';

/**
 * **Cancel…**, confirmed (ADR-0010 decision 8): `{confirmation}` is the display id (or date) typed when anyone is
 * registered. 202 with a `tournament_cancel` job, then follow `/api/submissions/{id}/events`; 200 when play-tools
 * already has it cancelled (cancelled here too, with no job).
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { id } = await getValidatedRouterParams(event, EditTargetParam.parse);
  const body = await readValidatedBody(event, CancelBody.parse);
  const started = await useSubmissions().cancelTournament(leagueId, { target: id, body, startedBy: user.username }).catch(submissionHttpError);
  setResponseStatus(event, started.submissionId === null ? 200 : 202);
  return started;
});
