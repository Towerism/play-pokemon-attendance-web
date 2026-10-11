/**
 * JSON errors (the `/api` routes) as Nitro renders them, minus Nitro's own
 * CSP: the app's CSP set by `plugins/security-headers.ts` stays on the
 * response, like every other security header (architecture §9). HTML errors
 * are Nuxt's error handler's job and never reach this one.
 */
export default defineNitroErrorHandler(async (error, event, { defaultHandler }) => {
  const res = await defaultHandler(error, event);
  const { 'content-security-policy': _nitroCsp, ...headers } = res.headers;
  setResponseHeaders(event, headers);
  setResponseStatus(event, res.status, res.statusText);
  return send(event, JSON.stringify(res.body, null, 2));
});
