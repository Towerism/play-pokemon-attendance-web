/**
 * `pnpm dev`'s counterpart of the production launcher (#137). `nuxt dev` never runs `.output/launcher.mjs`,
 * so without this the vault keys stay empty and the first Nitro plugin that builds a vault fails every request.
 *
 * Plain TS: `nuxt.config.ts` calls `devEnvHook` from its `ready` hook, before the Nitro dev server loads
 * and reads its runtime config from env. Secrets resolve exactly as in production (env, else
 * `dirname(NUXT_DATABASE_PATH)/secrets/`, default `.data/secrets/`, else generated).
 */
import { type Logger, prepareRuntimeEnv } from '@towerism/selfhost-kit';
import { createAppLogger } from '../logging/app-logger';
import { RUNTIME_ENV } from './app-env';

/**
 * Makes `env` exactly the prepared env, in place, as `runLauncher` does: blank tuning variables are removed
 * so runtime config keeps its defaults.
 */
export function prepareDevEnv(env: NodeJS.ProcessEnv, logger: Logger): void {
  const prepared = prepareRuntimeEnv(env, RUNTIME_ENV);
  for (const name of Object.keys(env)) {
    if (prepared.env[name] === undefined) Reflect.deleteProperty(env, name);
  }
  Object.assign(env, prepared.env);
  for (const line of prepared.log) logger.info(line);
}

/** What `devEnvHook` works on; tests pass their own, Nuxt gets `process.env` and a startup logger. */
export interface DevEnvDeps {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

/**
 * The `ready` hook body: prepares the env only under `nuxt dev`. `nuxt build`, `prepare` (postinstall) and
 * `typecheck` run with `dev: false`, so they never read, generate or write a secret. A malformed secret
 * throws the kit's `InvalidSecretError` / `InvalidConfigError`, which `nuxt dev` reports.
 */
export function devEnvHook(nuxt: { options: { dev: boolean } }, deps: DevEnvDeps = {}): void {
  if (!nuxt.options.dev) return;
  prepareDevEnv(deps.env ?? process.env, deps.logger ?? createAppLogger({ scope: 'startup' }));
}
