import { TemplateBody } from '#shared/schemas/tournaments';

/** A tournament template (ADR-0010 decision 3): 201. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const body = await readValidatedBody(event, TemplateBody.parse);
  const template = tournamentsCall(() => useTournaments().createTemplate(leagueId, body));
  setResponseStatus(event, 201);
  return { template };
});
