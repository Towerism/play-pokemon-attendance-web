import { contentSecurityPolicy, isHttpsSite, securityHeaders } from '@towerism/selfhost-kit';

/**
 * Security headers on every response (architecture §9), errors and API calls
 * included; nuxt-security only covers the HTML shell, where it re-sends the
 * CSP with the response's nonce. HSTS and `upgrade-insecure-requests` follow
 * `NUXT_PUBLIC_SITE_URL` at runtime: a plain-HTTP LAN install gets neither.
 */
export default defineNitroPlugin((nitroApp) => {
  const httpsSite = isHttpsSite(useRuntimeConfig().public.siteUrl);
  const headers = securityHeaders({ httpsSite });

  // The HTML shell's CSP comes from nuxt-security; give it the same runtime switch.
  nitroApp.hooks.hook('nuxt-security:routeRules', (rules) => {
    const all = (rules['/**'] ??= {});
    all.headers = {
      ...(all.headers || {}),
      contentSecurityPolicy: contentSecurityPolicy({ httpsSite, nonce: true }),
      strictTransportSecurity: httpsSite ? { maxAge: 15_552_000, includeSubdomains: false, preload: false } : false,
    };
  });

  nitroApp.hooks.hook('request', (event) => {
    setResponseHeaders(event, headers);
  });
});
