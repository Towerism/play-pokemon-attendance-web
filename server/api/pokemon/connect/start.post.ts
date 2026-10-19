/** Begin a connect: Pokémon's login URL, with a PKCE challenge and a state bound to this user for 10 minutes. */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event);
  return usePokemon().startConnect(actor.userId);
});
