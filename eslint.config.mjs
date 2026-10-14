// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs';

// Module rules (CLAUDE.md, architecture §3). Covered by test/unit/module-boundaries.test.ts.

const POKEMON_HOSTS = [
  {
    selector: 'Literal[value=/pokemon\\.com/]',
    message: 'Only server/modules/pokemon/adapters/* may call *.pokemon.com.',
  },
  {
    selector: 'TemplateElement[value.raw=/pokemon\\.com/]',
    message: 'Only server/modules/pokemon/adapters/* may call *.pokemon.com.',
  },
];

// h3 / Nitro / nuxt-auth-utils / server/utils auto-imports: invisible to no-restricted-imports.
const SERVER_AUTO_IMPORTS =
  /^(define(EventHandler|NitroPlugin|CachedEventHandler)|useRuntimeConfig|useNitroApp|useStorage|useEvent|createError|send(Error|Redirect|Stream)?|setResponse(Status|Header)|getRequestHeaders?|getQuery|getRouterParams?|getValidated(Query|RouterParams)|readBody|readValidatedBody|readMultipartFormData|getUserSession|setUserSession|requireUserSession|clearUserSession|hashPassword|verifyPassword|useDb|useDatabase|useAccounts|useRoster|useSessions|useTdfImports|useTdfArchive|useSightings|usePokemon|useSubmissions|useMetrics|usePlaySessionResolver|useStaffing|requireLeague|useLogger|useIntegrationTokens|useIntegrationDays|requireIntegrationToken|useTournaments)$/;

// Tests use Pokémon URLs as data (the play-tools callback); MSW and test/server/fake-pokemon.ts
// keep them off the network, so the host rule doesn't apply to them.
const TEST_FILES = ['**/*.test.ts', '**/test-helpers.ts', 'test/**'];

// What server/modules/* may take from @towerism/selfhost-kit (architecture §3). Everything else in the kit
// (logger, request id, secrets, vault, launcher) is wired in server/utils and injected. Each migration step
// that gives modules a kit type extends this list. Like every no-restricted-imports rule, it doesn't see a
// dynamic import() or require: that stays a review check.
const KIT_FOR_MODULES = ['setupCodeMatches', 'generateSetupCode', 'createFixedWindowLimiter', 'systemClock', 'Clock', 'FixedWindowLimiter', 'HitResult'];

// Browser-bundled code: the kit is server-only (node:crypto, node:fs, pino).
const NO_KIT_IN_BROWSER = {
  regex: '^@towerism/selfhost-kit(/.*)?$',
  message: '@towerism/selfhost-kit is server-only; app/ and shared/ are bundled for the browser.',
};

const NO_NUXT_IN_MODULES = {
  selector: `CallExpression[callee.name=${SERVER_AUTO_IMPORTS}]`,
  message: 'server/modules/* are plain TS: take dependencies as arguments instead of using h3/Nitro auto-imports.',
};

export default withNuxt(
  {
    ignores: ['.output/**', '.nuxt/**', 'server/db/migrations/**'],
  },
  {
    files: ['**/*.{ts,mts,js,mjs,vue}'],
    ignores: [
      'server/modules/pokemon/adapters/**',
      'spikes/**',
      ...TEST_FILES,
      'eslint.config.mjs',
      'test/unit/module-boundaries.test.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', ...POKEMON_HOSTS] },
  },
  {
    // M0 throwaway scripts (S2 still runs from them); not worth churning.
    files: ['spikes/**'],
    rules: { 'preserve-caught-error': 'off', '@typescript-eslint/no-dynamic-delete': 'off' },
  },
  {
    files: ['server/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(h3|nitropack|nitro|nuxt|nuxt-auth-utils|#imports|#app|#auth-utils|#nitro)(/.*)?$',
              message: 'server/modules/* are plain TS: no h3 or Nuxt imports.',
            },
            {
              regex: '(^|/)logging/(logger|request-id)$',
              message: 'server/modules/* take a Logger (server/logging/types) as a dependency; server/utils injects it.',
            },
            {
              regex: '^@towerism/selfhost-kit/nitro$',
              message: 'server/modules/* are plain TS: the kit’s /nitro adapters are h3-based.',
            },
          ],
          paths: [
            {
              name: '@towerism/selfhost-kit',
              allowImportNames: KIT_FOR_MODULES,
              message:
                'server/modules/* take only plain helpers from the kit; loggers, request ids, secrets and vaults are injected by server/utils.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['server/modules/**/*.ts'],
    ignores: ['server/modules/pokemon/adapters/**'],
    rules: { 'no-restricted-syntax': ['error', ...POKEMON_HOSTS, NO_NUXT_IN_MODULES] },
  },
  {
    files: ['server/modules/pokemon/adapters/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_NUXT_IN_MODULES] },
  },
  {
    // Server code logs through pino (redacted, request-tagged), never the console (architecture §10).
    files: ['server/**/*.ts'],
    ignores: TEST_FILES,
    rules: { 'no-console': 'error' },
  },
  {
    // Browser-side code builds Zod schemas under the CSP: take `z` from shared/zod (jitless).
    files: ['app/**/*.{ts,vue}', 'shared/**/*.ts'],
    ignores: ['shared/zod.ts', ...TEST_FILES],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^zod(/.*)?$',
              message: "Import z from shared/zod (jitless), not 'zod': the CSP forbids Zod's eval probe in the browser.",
            },
            NO_KIT_IN_BROWSER,
          ],
        },
      ],
    },
  },
  {
    // shared/zod.ts is exempt from the zod rule above but is still browser-bundled. No other block sets
    // no-restricted-imports on it, so this overrides nothing.
    files: ['shared/zod.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [NO_KIT_IN_BROWSER] }] },
  },
  {
    // Module tests may hold Pokémon URLs as data, but stay plain TS.
    files: TEST_FILES.map((glob) => `server/modules/${glob}`),
    rules: { 'no-restricted-syntax': ['error', NO_NUXT_IN_MODULES] },
  },
);
