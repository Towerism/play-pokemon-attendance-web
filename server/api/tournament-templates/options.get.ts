import { OptionsQuery } from '#shared/schemas/tournaments';

/** A form's choices read live from play-tools as one professor: types for the date, formats and venues. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const query = await getValidatedQuery(event, OptionsQuery.parse);
  return useTournaments().options(leagueId, query).catch(tournamentsHttpError);
});
