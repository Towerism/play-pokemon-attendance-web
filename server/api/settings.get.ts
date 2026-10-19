import { dateIn } from '../../shared/time/local-time';
import { DEFAULT_LEAGUE_ID } from '../modules/leagues';

/**
 * Who is signed in and whether they may see the league (ADR-0015 §3), the league settings kept by the app (the
 * Pokémon league lives on `GET /pokemon/connections`), and the league's clock: its time zone and today's date there,
 * read without play-tools so the Tournaments page needn't wait for it (#191). A professor not confirmed in the league
 * gets only their own account.
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  const { member, waiting } = usePokemon().access(actor);
  const access = { username: actor.username, role: actor.role, member, waiting };
  if (!member) return { access };
  const timeZone = leagueTimeZone();
  return {
    access,
    thresholds: useMetrics().getThresholds(DEFAULT_LEAGUE_ID),
    league: { timeZone, today: dateIn(new Date(), timeZone) },
  };
});
