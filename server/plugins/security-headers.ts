import { securityHeadersPlugin } from '@towerism/selfhost-kit/nitro';

/**
 * Security headers on every response (architecture §9), errors and API calls
 * included, from the kit. nuxt-security only covers the HTML shell, where the
 * kit's plugin hands it the same CSP (with the response's nonce) and HSTS.
 * HSTS and `upgrade-insecure-requests` follow `NUXT_PUBLIC_SITE_URL` at
 * runtime: a plain-HTTP LAN install gets neither.
 */
export default defineNitroPlugin((nitroApp) => {
  securityHeadersPlugin({ siteUrl: useRuntimeConfig().public.siteUrl })(nitroApp);
});
