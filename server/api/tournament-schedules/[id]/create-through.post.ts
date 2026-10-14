import { CreateThroughBody, IdParam } from '#shared/schemas/tournaments';

/** **Create through date…**: one `tournament_create` job for every tournament the schedule plans through the date (≤ 60). 202. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  const body = await readValidatedBody(event, CreateThroughBody.parse);
  const started = await useSubmissions()
    .createThrough(leagueId, { scheduleId: id, ...body, startedBy: user.username })
    .catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
