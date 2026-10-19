import { ConnectCompleteBody } from '#shared/schemas/pokemon';
import { DEFAULT_LEAGUE_ID } from '../../../modules/leagues';

/**
 * Finish a connect from the pasted `play-tools.pokemon.com/loggedIn?code=…&state=…` address: adds the caller's Pokémon
 * account, reconnects it, or moves it from the owner to the professor logging in (`claimed`, ADR-0015 §2).
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  const { url } = await readValidatedBody(event, ConnectCompleteBody.parse);
  const { connection, outcome } = await usePokemon().completeConnect(DEFAULT_LEAGUE_ID, actor, url).catch(pokemonHttpError);
  return { connection: connectionJson(connection), outcome };
});
