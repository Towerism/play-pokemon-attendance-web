/**
 * Production entry point, bundled to `.output/launcher.mjs` by `pnpm build`.
 *
 * Resolves secrets and derived settings into `process.env` *before* Nitro
 * loads, because Nitro reads its runtime config from env at import time.
 */
import { prepareRuntimeEnv } from './runtime-env';
import { InvalidSecretError } from './secrets';

try {
  const { env, log } = prepareRuntimeEnv(process.env);
  Object.assign(process.env, env);
  for (const line of log) console.log(`[startup] ${line}`);
} catch (err) {
  if (!(err instanceof InvalidSecretError)) throw err;
  console.error(`[startup] ${err.message}`);
  process.exit(1);
}

await import(new URL('./server/index.mjs', import.meta.url).href);
