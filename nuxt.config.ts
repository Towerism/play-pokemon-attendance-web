// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: true },
  modules: ['@nuxt/ui', '@nuxt/eslint', 'nuxt-auth-utils'],
  css: ['~/assets/css/main.css'],

  // Everything sits behind a login, so the app pages are a SPA (architecture §3).
  routeRules: { '/**': { ssr: false } },

  runtimeConfig: {
    // Overridden by env (NUXT_DATABASE_PATH etc.). The image sets /data/app.db.
    databasePath: '.data/app.db',
    migrationsDir: 'server/db/migrations',
    // Filled from env or /data/secrets/ by server/bootstrap/launcher.ts.
    tokenVaultKey: '',
    // Empty means the real Pokémon hosts. Only test doubles set these
    // (NUXT_POKEMON_ACCESS_URL / NUXT_POKEMON_API_URL); see test/server/fake-pokemon.ts.
    pokemon: { accessUrl: '', apiUrl: '' },
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
    // Hourly refresh-token keep-alive (ADR-0003). Cron runs in the container's TZ.
    experimental: { tasks: true },
    scheduledTasks: { '0 * * * *': ['pokemon:keepalive'] },
  },

  typescript: {
    tsConfig: {
      compilerOptions: { noUncheckedIndexedAccess: true },
    },
  },
})
