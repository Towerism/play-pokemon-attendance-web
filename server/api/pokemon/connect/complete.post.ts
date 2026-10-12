import { ConnectCompleteBody } from '#shared/schemas/pokemon';

/** Finish a connect from the pasted `play-tools.pokemon.com/loggedIn?code=…&state=…` address: adds the professor, or reconnects them. */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { url } = await readValidatedBody(event, ConnectCompleteBody.parse);
  const { connection, outcome } = await usePokemon().completeConnect(leagueId, user.id, url).catch(pokemonHttpError);
  return { connection: connectionJson(connection), outcome };
});
