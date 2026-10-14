// Shim (kit ADR-0007, A1): CSP and security headers now come from @towerism/selfhost-kit.
import { securityHeaders } from '@towerism/selfhost-kit';

export { type CspDirectives, contentSecurityPolicy, isHttpsSite, securityHeaders } from '@towerism/selfhost-kit';

/** Derived from the kit's headers, not copied. */
export const HSTS = securityHeaders({ httpsSite: true })['Strict-Transport-Security']!;

export const PERMISSIONS_POLICY = securityHeaders({ httpsSite: false })['Permissions-Policy']!;
