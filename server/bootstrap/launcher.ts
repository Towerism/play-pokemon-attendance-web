/**
 * Production entry point, bundled to `.output/launcher.mjs` by `pnpm build`.
 *
 * Resolves secrets and derived settings into `process.env` *before* Nitro
 * loads, because Nitro reads its runtime config from env at import time.
 */
import { createLogger } from '../logging/logger';
import { prepareRuntimeEnv } from './runtime-env';
import { InvalidSecretError } from './secrets';

const log = createLogger({ scope: 'startup' });
try {
  const { env, log: lines } = prepareRuntimeEnv(process.env);
  Object.assign(process.env, env);
  for (const line of lines) log.info(line);
} catch (err) {
  if (!(err instanceof InvalidSecretError)) throw err;
  log.error(err.message);
  process.exit(1);
}

await import(new URL('./server/index.mjs', import.meta.url).href);
