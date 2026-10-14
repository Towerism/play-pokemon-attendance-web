import { securityHeadersPlugin } from '@towerism/selfhost-kit/nitro';
import { describeBodySize, describeJsonOnly, describeSecurityHeaders, h3TestApp } from '@towerism/selfhost-kit/testing';
import { describe, expect, it } from 'vitest';
import bodySizeMiddleware from '../../server/middleware/body-size';
import jsonOnlyMiddleware from '../../server/middleware/json-only';

// The kit's contract suites (kit ADR-0008), run against attendance's own middleware and its configuration.

describeJsonOnly(jsonOnlyMiddleware);

describeBodySize(bodySizeMiddleware, {
  maxBytes: 2 * 1024 * 1024,
  // The TDF preview has its own, larger limit and its own 411/413.
  exemptPaths: ['/api/sessions/2026-10-10/tdf', '/api/sessions/2026-10-10/tdf/', '/api/sessions/2026-10-10/tdf?draft=1'],
});

describe('the TDF commit route is not exempt from the body size limit', () => {
  it('refuses a body over 2 MiB with 413, before any route', async () => {
    const app = h3TestApp({ middleware: [bodySizeMiddleware] });
    const res = await app.fetch('/api/sessions/2026-10-10/tdf/abc/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) },
    });
    expect(res.status).toBe(413);
  });
});

// server/plugins/security-headers.ts makes exactly this call with the runtime site URL, and server/error.ts uses
// the suite's default jsonErrorHandler(). Both files use Nitro auto-imports, so test/server/security.test.ts pins
// their wiring through the built server.
describeSecurityHeaders(securityHeadersPlugin({ siteUrl: 'https://attendance.example' }), { httpsSite: true });
describeSecurityHeaders(securityHeadersPlugin({ siteUrl: 'http://192.168.1.10:3000' }), { httpsSite: false });
