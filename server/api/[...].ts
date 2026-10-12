/**
 * Any `/api` path no other route handles, for any method, is a JSON 404.
 * Without it the `'/**': { ssr: false }` route rule hands it to the page
 * renderer, which answers 200 with the SPA shell. Specific routes still win.
 *
 * The `[...].<method>.ts` files re-export this per method. Nitro's typed
 * `$fetch` merges a `/**` route into every non-exact match and keeps only the
 * methods both routes share, so a catch-all with just `default` would turn
 * `useFetch(`/api/sessions/${date}`)` into `{}`. Per method, this `never`
 * drops out of the union and each route keeps its own response type.
 */
export default defineEventHandler((): never => {
  throw createError({ statusCode: 404, message: 'No such API route.' });
});
