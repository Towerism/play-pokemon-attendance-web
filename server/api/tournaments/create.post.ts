import { CreateTournamentsBody } from '#shared/schemas/tournaments';

/**
 * **Create in play-tools** (ADR-0010 decision 5): a `tournament_create` job for 1–60 planned tournaments, each as its
 * template's organizer, adopted instead when play-tools already has it. 202, then follow `/api/submissions/{id}/events`.
 */
export default defineEventHandler(async (event) => {
  const { leagueId, actor } = await requireMember(event);
  const body = await readValidatedBody(event, CreateTournamentsBody.parse);
  const started = await useSubmissions()
    .createTournaments(leagueId, { ...body, actor })
    .catch(submissionHttpError);
  setResponseStatus(event, 202);
  return started;
});
