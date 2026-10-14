import { CoverageQuery } from '#shared/schemas/tournaments';

/**
 * Required events coverage (ADR-0010 decision 12): each active requirement × its periods, with status, urgency and
 * action. 200 even when play-tools can't be read (those periods are `unknown`); `?refresh=1` lists again.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { refresh } = await getValidatedQuery(event, CoverageQuery.parse);
  return useTournaments().requiredEvents.read(leagueId, { refresh }).catch(tournamentsHttpError);
});
