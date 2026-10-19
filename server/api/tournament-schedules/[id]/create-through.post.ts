import { CreateThroughBody, IdParam } from '#shared/schemas/tournaments';

/** **Create through date…**: one `tournament_create` job for every tournament the schedule plans through the date (≤ 60). 202. */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const { id } = await getValidatedRouterParams(event, IdParam.parse);
  const body = await readValidatedBody(event, CreateThroughBody.parse);
  const started = await useSubmissions()
    .createThrough(leagueId, { scheduleId: id, ...body, actor })
    .catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
