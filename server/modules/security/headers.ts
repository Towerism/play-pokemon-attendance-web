/** CSP directive → sources; `upgrade-insecure-requests` is a flag. */
export type CspDirectives = Record<string, string[] | boolean>;

/**
 * True when `NUXT_PUBLIC_SITE_URL` is https. The same signal turns on the
 * Secure cookie: plain HTTP on the LAN must keep working (ADR-0006).
 */
export function isHttpsSite(siteUrl: string | undefined): boolean {
  try {
    return new URL(siteUrl ?? '').protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The app's CSP (architecture §9). Inline scripts are allowed only by the
 * per-response nonce that nuxt-security puts on the HTML shell's `<script>`s.
 */
export function contentSecurityPolicy(opts: { httpsSite: boolean; nonce?: boolean }): CspDirectives {
  return {
    'default-src': ["'self'"],
    'base-uri': ["'none'"],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'script-src': opts.nonce ? ["'self'", "'nonce-{{nonce}}'"] : ["'self'"],
    'script-src-attr': ["'none'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    // Over plain HTTP this would send the browser to https:// for every asset.
    'upgrade-insecure-requests': opts.httpsSite,
  };
}

/** HSTS is host-wide (every port), so only an HTTPS site gets it. */
export const HSTS = 'max-age=15552000';

export const PERMISSIONS_POLICY = 'camera=(), display-capture=(), fullscreen=(), geolocation=(), microphone=()';

/** Every header the app sends on every response, by name. */
export function securityHeaders(opts: { httpsSite: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': serializeCsp(contentSecurityPolicy(opts)),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'X-DNS-Prefetch-Control': 'off',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'X-XSS-Protection': '0',
    'Permissions-Policy': PERMISSIONS_POLICY,
  };
  if (opts.httpsSite) headers['Strict-Transport-Security'] = HSTS;
  return headers;
}

function serializeCsp(csp: CspDirectives): string {
  return Object.entries(csp)
    .filter(([, value]) => value !== false)
    .map(([directive, value]) => (value === true ? directive : `${directive} ${value.join(' ')}`))
    .join('; ');
}
