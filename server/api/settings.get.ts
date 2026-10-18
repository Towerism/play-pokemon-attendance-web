import { dateIn } from '../../shared/time/local-time';

/**
 * League settings kept by the app (the Pokémon league lives on `GET /pokemon/connections`), and the league's clock:
 * its time zone and today's date there, read without play-tools so the Tournaments page needn't wait for it (#191).
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const timeZone = leagueTimeZone();
  return { thresholds: useMetrics().getThresholds(leagueId), league: { timeZone, today: dateIn(new Date(), timeZone) } };
});
