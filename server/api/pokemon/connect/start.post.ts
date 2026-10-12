/** Begin a connect: Pokémon's login URL, with a PKCE challenge and a state bound to this user for 10 minutes. */
export default defineEventHandler(async (event) => {
  await requireLeague(event);
  const { user } = await requireUserSession(event);
  return usePokemon().startConnect(user.id);
});
