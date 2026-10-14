/**
 * Builds the rate limiters and trusted proxies at boot (architecture §9), so a setting the kit refuses fails
 * startup, naming its variables, instead of making the limited routes answer 500. The `0.` prefix makes Nitro
 * (which loads plugins in path order) run this before every other attendance plugin: a bad setting stops the
 * app before the database opens, jobs recover or the Pokémon plugin touches a refresh token.
 */
export default defineNitroPlugin(() => {
  useRateLimits();
});
