import { jsonErrorHandler } from '@towerism/selfhost-kit/nitro';

/**
 * JSON errors (the `/api` routes) as Nitro renders them, minus Nitro's own
 * CSP, from the kit: the app's CSP set by `plugins/security-headers.ts` stays
 * on the response, like every other security header (architecture §9). HTML
 * errors are Nuxt's error handler's job and never reach this one.
 */
export default defineNitroErrorHandler(jsonErrorHandler());
