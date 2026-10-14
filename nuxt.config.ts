import { DEFAULT_TRUSTED_PROXIES, contentSecurityPolicy, securityHeaders } from '@towerism/selfhost-kit';
import { devEnvHook } from './server/bootstrap/dev-env';

// The kit's Permissions-Policy (`camera=(), …`), for nuxt-security's HTML shell. test/server/security.test.ts
// asserts the same literal on the shell and on every other response.
const PERMISSIONS_POLICY = securityHeaders({ httpsSite: false })['Permissions-Policy']!;

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxt/eslint', 'nuxt-auth-utils', 'nuxt-security'],

  // `nuxt dev` never runs the production launcher: resolve the same secrets (into .data/secrets/) before
  // the Nitro dev server loads. A no-op for build, prepare and typecheck.
  hooks: { ready: (nuxt) => devEnvHook(nuxt) },

  // Architecture §9. nuxt-security nonces the HTML shell's inline scripts;
  // server/plugins/security-headers.ts (the kit's plugin) puts the same headers on every other
  // response and switches HSTS / upgrade-insecure-requests on for an HTTPS site.
  security: {
    nonce: true,
    headers: {
      contentSecurityPolicy: contentSecurityPolicy({ httpsSite: false, nonce: true }),
      strictTransportSecurity: false,
      crossOriginEmbedderPolicy: false,
      xFrameOptions: 'DENY',
      xDownloadOptions: false,
      permissionsPolicy: Object.fromEntries(PERMISSIONS_POLICY.split(', ').map((p) => [p.split('=')[0]!, []])),
    },
    // The kit's guards instead: auth rate limits keyed through trusted proxies
    // (enforceRateLimit, limiters from server/bootstrap/rate-limits.ts) and a 2 MiB
    // body cap that spares the TDF route (server/middleware/body-size.ts). The XSS validator would reject
    // every TDF upload (XML in JSON); Zod validates bodies. Same-origin only: no CORS.
    rateLimiter: false,
    requestSizeLimiter: false,
    xssValidator: false,
    corsHandler: false,
    allowedMethodsRestricter: false,
    removeLoggers: false,
  },
  css: ['~/assets/css/main.css'],

  // Everything sits behind a login, so the app pages are a SPA (architecture §3).
  routeRules: { '/**': { ssr: false } },

  runtimeConfig: {
    // Overridden by env (NUXT_DATABASE_PATH etc.). The image sets /data/app.db.
    databasePath: '.data/app.db',
    migrationsDir: 'server/db/migrations',
    // Filled from env or /data/secrets/ by server/bootstrap/launcher.ts (under `nuxt dev`, by server/bootstrap/dev-env.ts).
    tokenVaultKey: '',
    tdfVaultKey: '',
    // Empty means the real Pokémon hosts. Only test doubles set these
    // (NUXT_POKEMON_ACCESS_URL / NUXT_POKEMON_API_URL); see test/server/fake-pokemon.ts.
    pokemon: { accessUrl: '', apiUrl: '' },
    // ADR-0004: bulk calls of 20 players (≤ 50), 10 s apart; after a 5xx, re-read for up to 3 min
    // before resending (large batches can 502 yet land a minute later). NUXT_SUBMISSION_*.
    submission: { batchSize: 20, batchDelayMs: 10_000, settleMs: 180_000, settlePollMs: 15_000 },
    // Undo deletes one record at a time, at least this far apart (never under 500 ms). NUXT_UNDO_DELAY_MS.
    undo: { delayMs: 1_000 },
    // A staff job sends one write at a time, at least this far apart (never under 500 ms). NUXT_STAFF_DELAY_MS.
    staff: { delayMs: 1_000 },
    // A create job sends one tournament create at a time, at least this far apart (never under 2 s; ADR-0010
    // decision 5). NUXT_TOURNAMENT_DELAY_MS. Its settle window is the submission one.
    tournament: { delayMs: 5_000 },
    // Per-client limits on login and first-run setup (architecture §9).
    // NUXT_AUTH_RATE_LIMIT_*: optional tuning, validated by the launcher; not in the template.
    authRateLimit: {
      login: { max: 10, windowMs: 900_000 },
      setup: { max: 5, windowMs: 900_000 },
    },
    // Per-token limit on integrations day reads (#115, ADR-0013): each reads play-tools live, so a misbehaving
    // client can't turn into heavy upstream traffic. NUXT_INTEGRATION_RATE_LIMIT_*: optional, not in the template.
    integrationRateLimit: { max: 30, windowMs: 900_000 },
    // Peers whose X-Forwarded-For is believed (NUXT_TRUSTED_PROXIES): loopback and
    // Docker's bridge pool cover Caddy on the same Unraid box. Blank = this default.
    trustedProxies: DEFAULT_TRUSTED_PROXIES,
    session: {
      // The launcher turns this on when NUXT_PUBLIC_SITE_URL is https: a Secure
      // cookie is never sent back over plain-HTTP LAN access (ADR-0006).
      cookie: { secure: false, sameSite: 'lax' },
    },
    public: {
      siteUrl: '',
    },
  },

  nitro: {
    preset: 'node-server',
    // JSON errors keep the app's security headers (Nitro's default swaps the CSP).
    errorHandler: '~~/server/error',
    // Hourly refresh-token keep-alive (ADR-0003). Cron runs in the container's TZ.
    // asyncContext: the request id reaches every log record a request causes,
    // module and job logs included (architecture §10).
    experimental: { tasks: true, asyncContext: true },
    scheduledTasks: { '0 * * * *': ['pokemon:keepalive', 'tdf:expire'] },
  },

  typescript: {
    tsConfig: {
      compilerOptions: { noUncheckedIndexedAccess: true },
    },
  },
})
