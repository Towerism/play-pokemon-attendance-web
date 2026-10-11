import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/** The module rules from CLAUDE.md / architecture §3, as enforced by `eslint.config.mjs`. */
const eslint = new ESLint();

async function errors(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.severity === 2).map((m) => `${m.ruleId}: ${m.message}`);
}

describe('server/modules stay plain TS (no h3 / Nuxt)', () => {
  const file = 'server/modules/roster/service.ts';

  it.each([
    "import { createError } from 'h3';",
    "import { useRuntimeConfig } from '#imports';",
    "import { defineNuxtConfig } from 'nuxt/config';",
    "import { setUserSession } from 'nuxt-auth-utils';",
  ])('rejects %s', async (code) => {
    expect(await errors(file, `${code}\nexport { ${code.match(/{ (\w+) }/)![1]} };`)).toEqual([expect.stringMatching(/no-restricted-imports/)]);
  });

  it.each([
    'useRuntimeConfig()',
    "createError({ statusCode: 400 })",
    'useDb()',
    'readValidatedBody(e, f)',
    'useRoster()',
    'useSessions()',
    'useTdfImports()',
    'usePokemon()',
    'useSightings()',
    'useSubmissions()',
    'usePlaySessionResolver()',
    'requireLeague(e)',
  ])(
    'rejects the auto-imported call %s',
    async (call) => {
      expect(await errors(file, `export const x = () => ${call};`)).toEqual([
        expect.stringMatching(/no-restricted-syntax/),
      ]);
    },
  );

  it('allows plain TS and other modules', async () => {
    expect(await errors(file, "import { z } from 'zod';\nimport type { Db } from '../../db/client';\nexport const s = z.string();\nexport type D = Db;")).toEqual([]);
  });

  it('does not restrict server/api handlers', async () => {
    expect(await errors('server/api/x.get.ts', 'export default defineEventHandler(() => useRuntimeConfig());')).toEqual([]);
  });
});

describe('only pokemon adapters talk to *.pokemon.com', () => {
  const callsUpstream = "export const url = 'https://api.play.pokemon.com/services/core/';";

  it.each(['server/modules/submission/service.ts', 'server/api/pokemon/connection.get.ts', 'app/pages/settings.vue', 'shared/x.ts'])(
    'rejects a pokemon.com URL in %s',
    async (file) => {
      const code = file.endsWith('.vue')
        ? "<script setup lang=\"ts\">\nconst url = 'https://api.play.pokemon.com/';\nconsole.log(url);\n</script>"
        : callsUpstream;
      expect(await errors(file, code)).toEqual([expect.stringMatching(/no-restricted-syntax/)]);
    },
  );

  it('rejects it in a template literal too', async () => {
    expect(await errors('server/modules/x/y.ts', 'export const u = (h: string) => `https://${h}.pokemon.com/`;')).toEqual([
      expect.stringMatching(/no-restricted-syntax/),
    ]);
  });

  it.each(['server/modules/pokemon/adapters/play-tools/constants.ts', 'spikes/s3-discover.ts'])('allows it in %s', async (file) => {
    expect(await errors(file, callsUpstream)).toEqual([]);
  });

  // Tests use the play-tools callback URL as data; MSW and the fake upstream keep them off the network.
  it.each(['server/modules/pokemon/connection.test.ts', 'server/modules/pokemon/test-helpers.ts', 'shared/schemas/pokemon.test.ts', 'test/server/pokemon.test.ts'])(
    'allows it as test data in %s',
    async (file) => {
      expect(await errors(file, callsUpstream)).toEqual([]);
    },
  );

  it('still keeps h3/Nitro auto-imports out of module tests', async () => {
    expect(await errors('server/modules/pokemon/connection.test.ts', 'export const x = () => useDb();')).toEqual([
      expect.stringMatching(/no-restricted-syntax/),
    ]);
  });
});
