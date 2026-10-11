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
  /^(define(EventHandler|NitroPlugin|CachedEventHandler)|useRuntimeConfig|useNitroApp|useStorage|useEvent|createError|send(Error|Redirect|Stream)?|setResponse(Status|Header)|getRequestHeaders?|getQuery|getRouterParams?|getValidated(Query|RouterParams)|readBody|readValidatedBody|readMultipartFormData|getUserSession|setUserSession|requireUserSession|clearUserSession|hashPassword|verifyPassword|useDb|useDatabase|useAccounts|useRoster|useSessions|useTdfImports|useSightings|usePokemon|useSubmissions|usePlaySessionResolver|requireLeague)$/;

// Tests use Pokémon URLs as data (the play-tools callback); MSW and test/server/fake-pokemon.ts
// keep them off the network, so the host rule doesn't apply to them.
const TEST_FILES = ['**/*.test.ts', '**/test-helpers.ts', 'test/**'];

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
    // Module tests may hold Pokémon URLs as data, but stay plain TS.
    files: TEST_FILES.map((glob) => `server/modules/${glob}`),
    rules: { 'no-restricted-syntax': ['error', NO_NUXT_IN_MODULES] },
  },
);
