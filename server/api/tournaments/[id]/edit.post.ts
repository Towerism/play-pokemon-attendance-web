import { ApplyBody, EditTargetParam } from '#shared/schemas/tournaments';

/**
 * **Edit…**, applied (ADR-0010 decisions 8 and 11): planned tournaments change locally, and those in play-tools get a
 * `tournament_edit` job. 202 with the job, then follow `/api/submissions/{id}/events`; 200 when only planned ones changed.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { id } = await getValidatedRouterParams(event, EditTargetParam.parse);
  const body = await readValidatedBody(event, ApplyBody.parse);
  const started = await useSubmissions().editTournaments(leagueId, { target: id, body, startedBy: user.username }).catch(submissionHttpError);
  setResponseStatus(event, started.submissionId === null ? 200 : 202);
  return started;
});
