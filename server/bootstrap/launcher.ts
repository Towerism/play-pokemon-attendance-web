/**
 * Production entry point, bundled to `.output/launcher.mjs` by `pnpm build`.
 *
 * Resolves secrets and derived settings into `process.env` *before* Nitro
 * loads, because Nitro reads its runtime config from env at import time.
 * The kit's `runLauncher` does that, then imports the server; on a malformed
 * secret or config it logs one startup error and exits with 1. It requires a
 * logger and is given attendance's configured one: any other would redact
 * only the kit's base keys (ESLint enforces this).
 */
import { prepareRuntimeEnv, runLauncher } from '@towerism/selfhost-kit';
import { createAppLogger } from '../logging/app-logger';
import { RUNTIME_ENV } from './app-env';

await runLauncher({
  prepare: (env) => prepareRuntimeEnv(env, RUNTIME_ENV),
  server: new URL('./server/index.mjs', import.meta.url),
  logger: createAppLogger({ scope: 'startup' }),
});
